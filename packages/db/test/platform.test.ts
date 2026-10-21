import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "../src/index.ts";
import * as root from "../src/index.ts";
import { withPlatformTx } from "../src/platform.ts";

import { fixture, migratedDb, uuid7 } from "./helpers.ts";

import type pg from "pg";

let pool: pg.Pool;
let drop: () => Promise<void>;
beforeAll(async () => {
  const db = await migratedDb([fixture("good")]);
  drop = () => db.drop();
  pool = createPool(db.url("app"), { max: 1 });
});
afterAll(async () => {
  await pool.end();
  await drop();
});

const ok = { reason: "support ticket 1", requestId: "r", actorId: uuid7() };
const noop = () => Promise.resolve();

describe("withPlatformTx (platform-only subpath)", () => {
  it("is exported from ./platform, not from the package root", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./platform"]).toBe("./src/platform.ts");
    expect("withPlatformTx" in root).toBe(false);
  });
  it("sets platform flag + reason, no tenant", async () => {
    const res = await withPlatformTx(pool, ok, (tx) =>
      tx.query(
        "select current_setting('app.platform', true) p, current_setting('app.platform_reason', true) why, current_setting('app.actor_id', true) a, coalesce(current_setting('app.tenant_id', true), '') t",
      ),
    );
    expect(res.rows[0]).toEqual({ p: "on", why: ok.reason, a: ok.actorId, t: "" });
    expect((await pool.query("select current_setting('app.platform', true) p")).rows[0]).toEqual({
      p: "",
    });
  });
  it("validates actorId, reason and requestId", async () => {
    await expect(withPlatformTx(pool, { ...ok, actorId: "a1" }, noop)).rejects.toThrow(/actorId/);
    for (const reason of ["", " ", "x".repeat(201), "bad\nnewline", "nul\u0000"]) {
      await expect(withPlatformTx(pool, { ...ok, reason }, noop)).rejects.toThrow(/reason/);
    }
    await withPlatformTx(pool, { ...ok, reason: "x".repeat(200) }, noop);
    for (const requestId of ["", "r".repeat(129)]) {
      await expect(withPlatformTx(pool, { ...ok, requestId }, noop)).rejects.toThrow(/requestId/);
    }
  });
});
