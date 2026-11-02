import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import type { ElectronApplication, Page } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");

let app: ElectronApplication;
let page: Page;
let userData: string;

interface Bridge {
  display: {
    screens: () => Promise<{ screens: { id: number }[]; chosen: number | null }>;
    choose: (id: number | null) => Promise<void>;
    show: (s: unknown) => Promise<void>;
  };
  kiosk: {
    status: () => Promise<{ enabled: boolean; hasPin: boolean }>;
    setPin: (pin: string, current?: string) => Promise<void>;
    setEnabled: (on: boolean, pin?: string) => Promise<void>;
    verify: (pin: string) => Promise<boolean>;
  };
}

test.beforeAll(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "wb-desktop-dk-"));
  app = await electron.launch({
    args: [root],
    env: { ...process.env, WISE_BIZ_E2E: "1", WISE_BIZ_USER_DATA: userData },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  const exited = new Promise<void>((resolve) => {
    app.process().once("exit", () => {
      resolve();
    });
  });
  // Kiosk mode refuses to close the window, so end the process the way an admin would.
  await app
    .evaluate(({ app: a }) => {
      a.exit(0);
    })
    .catch(() => undefined);
  await exited;
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("the customer display mirrors the cart within 50 ms and renders text only", async () => {
  const id = await page.evaluate(async () => {
    const b = (globalThis as unknown as { wiseDesktop: Bridge }).wiseDesktop;
    const { screens } = await b.display.screens();
    const first = screens[0]?.id ?? 0;
    await b.display.choose(first);
    return first;
  });
  expect(id).not.toBe(0);

  await expect
    .poll(() => app.windows().filter((w) => w.url().startsWith("app://display/")).length)
    .toBe(1);
  const display = app.windows().find((w) => w.url().startsWith("app://display/"));
  if (display === undefined) throw new Error("no display window");
  await expect(display.locator("#message")).toHaveText("Welcome");

  const sentAt = await page.evaluate(async () => {
    const t = Date.now();
    await (globalThis as unknown as { wiseDesktop: Bridge }).wiseDesktop.display.show({
      lines: [
        { name: "Green Tea", qty: "2", totalMinor: 1006 },
        { name: "<img src=x onerror=document.title='pwned'>", qty: "1", totalMinor: 800 },
      ],
      totalMinor: 1986,
      changeMinor: 14,
      currency: "USD",
      message: "Thank you",
    });
    return t;
  });
  await expect(display.locator("#total")).toHaveText("$19.86");
  const seenAt = await display.evaluate(
    () => (globalThis as unknown as { __lastStateAt: number }).__lastStateAt,
  );
  expect(seenAt - sentAt).toBeLessThan(50);
  await expect(display.locator("#change")).toHaveText("$0.14");
  await expect(display.locator("#lines li")).toHaveCount(2);
  await expect(display.locator("#lines li").nth(1)).toContainText("<img src=x");
  expect(await display.title()).toBe("Customer display");
  expect(await display.locator("#lines img").count()).toBe(0);
});

test("kiosk mode needs a PIN, blocks reload and close, and is left with the PIN", async () => {
  const status = () =>
    page.evaluate(() =>
      (globalThis as unknown as { wiseDesktop: Bridge }).wiseDesktop.kiosk.status(),
    );
  expect(await status()).toEqual({ enabled: false, hasPin: false });
  await expect(
    page.evaluate(() =>
      (globalThis as unknown as { wiseDesktop: Bridge }).wiseDesktop.kiosk.setEnabled(true),
    ),
  ).rejects.toThrow("Set an admin PIN");

  await page.evaluate(async () => {
    const k = (globalThis as unknown as { wiseDesktop: Bridge }).wiseDesktop.kiosk;
    await k.setPin("246810");
    await k.setEnabled(true);
  });
  expect(await status()).toEqual({ enabled: true, hasPin: true });
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.isDestroyed() && w.getTitle() !== "Customer display")
        ?.isKiosk(),
    ),
  ).toBe(true);

  // Reload keys do nothing: a marker set on the page survives F5 and Ctrl+R.
  await page.evaluate(() => {
    (globalThis as unknown as { __marker: number }).__marker = 1;
  });
  await page.keyboard.press("F5");
  await page.keyboard.press("Control+R");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (globalThis as unknown as { __marker?: number }).__marker)).toBe(
    1,
  );

  // The window cannot be closed while kiosk is on.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() !== "Customer display")
      ?.close();
  });
  await page.waitForTimeout(300);
  expect(page.isClosed()).toBe(false);

  await expect(
    page.evaluate(() =>
      (globalThis as unknown as { wiseDesktop: Bridge }).wiseDesktop.kiosk.setEnabled(
        false,
        "000000",
      ),
    ),
  ).rejects.toThrow("not right");
  await page.evaluate(() =>
    (globalThis as unknown as { wiseDesktop: Bridge }).wiseDesktop.kiosk.setEnabled(
      false,
      "246810",
    ),
  );
  expect(await status()).toEqual({ enabled: false, hasPin: true });
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() !== "Customer display")
        ?.isKiosk(),
    ),
  ).toBe(false);
});
