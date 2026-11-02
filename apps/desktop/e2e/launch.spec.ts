import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import type { ElectronApplication, Page } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");

let app: ElectronApplication;
let page: Page;
let userData: string;

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "wb-desktop-"));
  app = await electron.launch({
    args: [root],
    env: { ...process.env, WISE_BIZ_E2E: "1", WISE_BIZ_USER_DATA: userData },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
});

test("loads the bundled POS from the app origin with a strict CSP", async () => {
  expect(page.url()).toMatch(/^app:\/\/pos\//);
  await expect(page.locator("body")).not.toBeEmpty();
  const csp = await page.evaluate(async () => {
    const r = await fetch(location.href);
    return r.headers.get("content-security-policy");
  });
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
});

test("the renderer has no Node and only the allowlisted bridge", async () => {
  const facts = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    nodeVersion:
      (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node ??
      null,
    keys: Object.keys((globalThis as { wiseDesktop?: object }).wiseDesktop ?? {}).sort(),
    db: Object.keys((globalThis as { wiseDesktop?: { db: object } }).wiseDesktop?.db ?? {}).sort(),
  }));
  expect(facts.require).toBe("undefined");
  // The bundle shims `process.env` for Expo; real Node (versions.node) must not be there.
  expect(facts.nodeVersion).toBeNull();
  expect(facts.keys).toEqual(["db", "platform", "vault", "version"]);
  expect(facts.db).toEqual(
    ["all", "begin", "close", "commit", "exec", "get", "open", "rollback", "run"].sort(),
  );
});

test("navigation away and new windows are blocked", async () => {
  await expect(page.locator("body")).not.toBeEmpty();
  await page.waitForTimeout(500);
  const before = page.url();
  await page.evaluate(() => {
    location.href = "https://example.com/";
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  const opened = await page.evaluate(() => window.open("https://example.com/") === null);
  expect(opened).toBe(true);
  expect(app.windows()).toHaveLength(1);
});

test("the database lives in the main process and survives a transaction", async () => {
  const rows = await page.evaluate(async () => {
    const d = (
      globalThis as unknown as {
        wiseDesktop: { db: Record<string, (...a: unknown[]) => Promise<unknown>> };
      }
    ).wiseDesktop.db;
    await d.open!("e2e-device");
    await d.exec!("CREATE TABLE IF NOT EXISTS t (id integer PRIMARY KEY, v text)");
    await d.begin!();
    await d.run!("INSERT INTO t (v) VALUES (?)", ["kept"]);
    await d.commit!();
    await d.begin!();
    await d.run!("INSERT INTO t (v) VALUES (?)", ["dropped"]);
    await d.rollback!();
    return d.all!("SELECT v FROM t ORDER BY id");
  });
  expect(rows).toEqual([{ v: "kept" }]);
  expect(fs.existsSync(path.join(userData, "wise-biz-e2e-device.db"))).toBe(true);
});

test("the vault keeps the identity encrypted on disk", async () => {
  const secret = "device-secret-key-material";
  await page.evaluate(async (v) => {
    const w = (
      globalThis as unknown as { wiseDesktop: { vault: { save: (s: string) => Promise<void> } } }
    ).wiseDesktop;
    await w.vault.save(JSON.stringify({ secretKey: v }));
  }, secret);
  const raw = fs.readFileSync(path.join(userData, "identity.bin"));
  expect(raw.includes(Buffer.from(secret))).toBe(false);
  const back = await page.evaluate(() =>
    (
      globalThis as unknown as {
        wiseDesktop: { vault: { load: () => Promise<string | undefined> } };
      }
    ).wiseDesktop.vault.load(),
  );
  expect(back).toContain(secret);
});
