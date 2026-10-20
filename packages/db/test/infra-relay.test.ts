import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendOutbox,
  bumpAttempts,
  claimOutboxBatch,
  markPublished,
  recordDeadLetter,
  recordProcessed,
  withTenantTx,
} from "../src/index.ts";

import { uuid7 } from "./helpers.ts";
import { ctx, event, infraSetup } from "./infra-helpers.ts";

import type pg from "pg";

let app: pg.Pool;
let worker: pg.Pool;
let migrator: pg.Pool;
let drop: () => Promise<void>;
const A = uuid7();
const B = uuid7();

beforeAll(async () => {
  ({ app, worker, migrator, drop } = await infraSetup());
  for (const t of [A, B]) {
    await withTenantTx(app, ctx(t), (tx) =>
      appendOutbox(
        tx,
        Array.from({ length: 500 }, () => event()),
      ),
    );
  }
});
afterAll(async () => {
  await drop();
});

async function inTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await worker.connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

describe("relay", () => {
  it("claims across tenants without a tenant context", async () => {
    const rows = await inTx((c) => claimOutboxBatch(c, { limit: 1000 }));
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([A, B]));
    expect(rows).toHaveLength(1000);
    expect(rows[0]?.attempts).toBe(0);
  });

  it("two concurrent claimers never share a row (SKIP LOCKED)", async () => {
    const [c1, c2] = await Promise.all([worker.connect(), worker.connect()]);
    try {
      await Promise.all([c1.query("begin"), c2.query("begin")]);
      const [r1, r2] = await Promise.all([
        claimOutboxBatch(c1, { limit: 700 }),
        claimOutboxBatch(c2, { limit: 700 }),
      ]);
      const ids = new Set(r1.map((r) => r.id));
      expect(r2.some((r) => ids.has(r.id))).toBe(false);
      expect(r1.length + r2.length).toBe(1000);
    } finally {
      await Promise.all([c1.query("rollback"), c2.query("rollback")]);
      c1.release();
      c2.release();
    }
  });

  it("rejects a bad limit", async () => {
    await expect(claimOutboxBatch(worker, { limit: 0 })).rejects.toThrow(/limit/);
  });

  it("bumpAttempts then markPublished; published rows leave the queue", async () => {
    const rows = await inTx((c) => claimOutboxBatch(c, { limit: 10 }));
    const keys = rows.map((r) => ({ tenantId: r.tenantId, id: r.id }));
    expect(await bumpAttempts(worker, keys)).toBe(10);
    expect(await markPublished(worker, keys.slice(0, 6))).toBe(6);
    expect(await markPublished(worker, keys.slice(0, 6))).toBe(0);
    expect(await markPublished(worker, [])).toBe(0);
    expect(await bumpAttempts(worker, [])).toBe(0);
    const left = await inTx((c) => claimOutboxBatch(c, { limit: 2000 }));
    expect(left).toHaveLength(994);
    expect(left.filter((r) => r.attempts === 1)).toHaveLength(4);
  });
});

describe("consumer tables", () => {
  const eventId = uuid7();
  it("recordProcessed is true once, then false", async () => {
    const p = { tenantId: A, consumer: "c1", eventId };
    expect(await recordProcessed(worker, p)).toBe(true);
    expect(await recordProcessed(worker, p)).toBe(false);
    expect(await recordProcessed(worker, { ...p, consumer: "c2" })).toBe(true);
  });

  it("recordDeadLetter truncates, strips stack, dedupes", async () => {
    const p = {
      tenantId: A,
      consumer: "c1",
      eventId,
      error: `${"x".repeat(3000)}\n    at stack`,
      attempts: 3,
      payload: { z: 1 },
    };
    expect(await recordDeadLetter(worker, p)).toBe(true);
    expect(await recordDeadLetter(worker, p)).toBe(false);
    const r = await worker.query<{ error: string }>("select error from infra.dead_letters");
    expect(r.rows[0]?.error).toHaveLength(1000);
    await recordDeadLetter(worker, { ...p, eventId: uuid7(), error: "" });
    await worker.query("delete from infra.dead_letters");
  });

  it("migrator (owner) is still blocked by forced RLS", async () => {
    const r = await migrator.query("select 1 from infra.outbox");
    expect(r.rowCount).toBe(0);
  });
});
