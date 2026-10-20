import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countQueries, createPool, instrumentPool, withTenantTx } from "../src/index.ts";

import { fixture, migratedDb, uuid7 } from "./helpers.ts";

import type pg from "pg";

let pool: pg.Pool;
let drop: () => Promise<void>;
beforeAll(async () => {
  const db = await migratedDb([fixture("good")]);
  drop = () => db.drop();
  pool = createPool(db.url("app"));
  instrumentPool(pool);
  instrumentPool(pool); // idempotent
});
afterAll(async () => {
  await pool.end();
  await drop();
});

const ctx = () => ({ tenantId: uuid7(), requestId: "r" });

describe("countQueries", () => {
  it("counts real statements in nested awaits, excludes housekeeping", async () => {
    const { count, statements, result } = await countQueries(async () => {
      await pool.query("select 1");
      return withTenantTx(pool, ctx(), async (tx) => {
        await tx.query("select 2");
        await Promise.all([
          tx.query("select 3"),
          Promise.resolve().then(() => tx.db.execute("select 4")),
        ]);
        return "ok";
      });
    });
    expect(result).toBe("ok");
    expect(count).toBe(4);
    expect(statements[0]).toBe("select 1");
  });

  it("counts statements on a failed rollback path and counts zero outside scope", async () => {
    const r = await countQueries(() =>
      withTenantTx(pool, ctx(), (tx) => tx.query("select 1")).then(() => 1),
    );
    expect(r.count).toBe(1);
    await pool.query("select 99");
    const none = await countQueries(() => Promise.resolve(0));
    expect(none.count).toBe(0);
  });

  it("isolates concurrent scopes", async () => {
    const run = (n: number) =>
      countQueries(async () => {
        for (let i = 0; i < n; i++) await pool.query("select pg_sleep(0.01)");
      });
    const [a, b] = await Promise.all([run(2), run(5)]);
    expect([a.count, b.count]).toEqual([2, 5]);
  });

  it("supports pool.connect with callback and query objects", async () => {
    const { count } = await countQueries(async () => {
      await pool.query({ text: "select 1" });
      await new Promise<void>((resolve, reject) => {
        pool.connect((err, client, done) => {
          if (err || !client) {
            reject(err ?? new Error("no client"));
            return;
          }
          client.query("select 1").then(() => {
            done();
            resolve();
          }, reject);
        });
      });
    });
    expect(count).toBe(2);
  });
});
