import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withTenantTx } from "../src/index.ts";

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

  it("handle is closed after the tx ends: db and query throw", async () => {
    const t = uuid7();
    const leaked = await withTenantTx(pool, { tenantId: t, requestId: "r" }, (tx) =>
      Promise.resolve(tx),
    );
    await expect(leaked.query("select 1")).rejects.toThrow(/closed/);
    await expect(leaked.db.execute(sql`select 1`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/closed/) as unknown },
    });
  });
});
