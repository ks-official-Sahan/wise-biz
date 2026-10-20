import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPlatformTx, withTenantTx } from "../src/index.ts";

import { fixture, migratedDb, uuid7 } from "./helpers.ts";

import type pg from "pg";

let pool: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await migratedDb([fixture("good")]);
  drop = () => db.drop();
  pool = createPool(db.url("app"), { max: 1, applicationName: "tx-test" });
});
afterAll(async () => {
  await pool.end();
  await drop();
});

const show =
  "select current_setting('app.tenant_id', true) t, current_setting('app.user_id', true) u, current_setting('app.request_id', true) r";

describe("withTenantTx", () => {
  it("sets settings inside, none leak to the reused pooled client", async () => {
    const a = uuid7();
    const inside = await withTenantTx(pool, { tenantId: a, userId: "u1", requestId: "r1" }, (tx) =>
      tx.query(show),
    );
    expect(inside.rows[0]).toEqual({ t: a, u: "u1", r: "r1" });
    const b = uuid7();
    const other = await withTenantTx(pool, { tenantId: b, requestId: "r2" }, (tx) =>
      tx.query(show),
    );
    expect(other.rows[0]).toEqual({ t: b, u: "", r: "r2" });
    const outside = await pool.query(show);
    expect(outside.rows[0]).toEqual({ t: "", u: "", r: "" });
  });

  it("commits on success and rolls back on throw", async () => {
    const t = uuid7();
    const ctx = { tenantId: t, requestId: "r" };
    await expect(
      withTenantTx(pool, ctx, async (tx) => {
        await tx.query("insert into good.items (tenant_id, name) values ($1, 'x')", [t]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(
      (await withTenantTx(pool, ctx, (tx) => tx.query("select 1 from good.items"))).rowCount,
    ).toBe(0);
    await withTenantTx(pool, ctx, (tx) =>
      tx.query("insert into good.items (tenant_id, name) values ($1, 'y')", [t]),
    );
    expect(
      (await withTenantTx(pool, ctx, (tx) => tx.query("select 1 from good.items"))).rowCount,
    ).toBe(1);
  });

  it("rejects non UUIDv7 tenant ids before BEGIN", async () => {
    for (const bad of ["", "nope", "00000000-0000-4000-8000-000000000000", "x'; drop table y;--"]) {
      await expect(
        withTenantTx(pool, { tenantId: bad, requestId: "r" }, () => Promise.resolve(1)),
      ).rejects.toThrow(/UUIDv7/);
    }
  });

  it("destroys the connection when rollback itself fails", async () => {
    const t = uuid7();
    await expect(
      withTenantTx(pool, { tenantId: t, requestId: "r" }, async (tx) => {
        await tx.query("select pg_terminate_backend(pg_backend_pid())").catch(() => undefined);
        throw new Error("dead");
      }),
    ).rejects.toThrow();
    // pool recovers with a fresh connection
    const ok = await withTenantTx(pool, { tenantId: t, requestId: "r" }, (tx) =>
      tx.query("select 1 as one"),
    );
    expect(ok.rows[0]).toEqual({ one: 1 });
  });
});

describe("withPlatformTx", () => {
  it("sets platform flag + reason, no tenant", async () => {
    const res = await withPlatformTx(
      pool,
      { reason: "support ticket 1", requestId: "r", actorId: "a1" },
      (tx) =>
        tx.query(
          "select current_setting('app.platform', true) p, current_setting('app.platform_reason', true) why, current_setting('app.actor_id', true) a, current_setting('app.tenant_id', true) t",
        ),
    );
    expect(res.rows[0]).toEqual({ p: "on", why: "support ticket 1", a: "a1", t: "" });
    expect((await pool.query("select current_setting('app.platform', true) p")).rows[0]).toEqual({
      p: "",
    });
  });
  it("requires a reason", async () => {
    await expect(
      withPlatformTx(pool, { reason: " ", requestId: "r", actorId: "a" }, () => Promise.resolve()),
    ).rejects.toThrow(/reason/);
  });
});
