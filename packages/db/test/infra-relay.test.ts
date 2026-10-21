import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendOutbox,
  claimOutboxBatch,
  markPublished,
  pruneOutbox,
  pruneProcessedEvents,
  quarantineExhausted,
  recordDeadLetter,
  recordProcessed,
  releaseClaims,
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
const W = "w1";

beforeAll(async () => {
  ({ app, worker, migrator, drop } = await infraSetup());
});
afterAll(async () => {
  await drop();
});

const seed = async (n: number, tenants = [A, B]): Promise<void> => {
  await worker.query("delete from infra.outbox");
  for (const t of tenants)
    await withTenantTx(app, ctx(t), (tx) =>
      appendOutbox(
        tx,
        Array.from({ length: n }, () => event()),
      ),
    );
};
const keys = (rows: { tenantId: string; id: string }[]) =>
  rows.map((r) => ({ tenantId: r.tenantId, id: r.id }));
const sql = async <T extends object>(q: string, p: unknown[] = []): Promise<T[]> =>
  (await worker.query<T>(q, p)).rows;

describe("relay leases", () => {
  it("claims across tenants in order; excludes live leases; attempts +1 per claim", async () => {
    await seed(500);
    const rows = await claimOutboxBatch(worker, { limit: 1000, workerId: W });
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(new Set([A, B]));
    expect(rows).toHaveLength(1000);
    expect(rows.every((r) => r.attempts === 1 && r.claimedBy === W && r.claimedUntil)).toBe(true);
    const t = rows.map((r) => r.createdAt.getTime());
    expect(t).toEqual([...t].sort((a, b) => a - b));
    expect(await claimOutboxBatch(worker, { workerId: "w2" })).toHaveLength(0);
  });

  it("expired lease is reclaimable and attempts increments", async () => {
    await seed(5, [A]);
    const first = await claimOutboxBatch(worker, { workerId: W, leaseMs: 1000 });
    expect(first).toHaveLength(5);
    await worker.query("update infra.outbox set claimed_until = now() - interval '1 second'");
    const again = await claimOutboxBatch(worker, { workerId: "w2" });
    expect(again).toHaveLength(5);
    expect(again.every((r) => r.attempts === 2 && r.claimedBy === "w2")).toBe(true);
  });

  it("excludes rows at maxAttempts; quarantineExhausted parks them once lease expires", async () => {
    await seed(3, [A]);
    await worker.query("update infra.outbox set attempts = 2");
    expect(await claimOutboxBatch(worker, { workerId: W, maxAttempts: 2 })).toHaveLength(0);
    expect(await claimOutboxBatch(worker, { workerId: W, maxAttempts: 3 })).toHaveLength(3);
    // attempts now 3, lease live -> not quarantined yet
    expect(await quarantineExhausted(worker, { maxAttempts: 3 })).toHaveLength(0);
    await worker.query("update infra.outbox set claimed_until = now() - interval '1 second'");
    const q = await quarantineExhausted(worker, { maxAttempts: 3 });
    expect(q).toHaveLength(3);
    expect(q[0]?.tenantId).toBe(A);
    expect(await quarantineExhausted(worker, { maxAttempts: 3 })).toHaveLength(0);
    expect(await claimOutboxBatch(worker, { workerId: W, maxAttempts: 99 })).toHaveLength(0);
  });

  it("two concurrent claimers get disjoint sets covering 1000 rows", async () => {
    await seed(500);
    const [r1, r2] = await Promise.all([
      claimOutboxBatch(worker, { limit: 700, workerId: "a" }),
      claimOutboxBatch(worker, { limit: 700, workerId: "b" }),
    ]);
    const ids = new Set(r1.map((r) => r.id));
    expect(r2.some((r) => ids.has(r.id))).toBe(false);
    expect(r1.length + r2.length).toBe(1000);
  });

  it("rejects bad options", async () => {
    await expect(claimOutboxBatch(worker, { limit: 0, workerId: W })).rejects.toThrow(/limit/);
    await expect(claimOutboxBatch(worker, { workerId: "" })).rejects.toThrow(/workerId/);
  });

  it("markPublished only by the lease owner; releaseClaims frees for retry", async () => {
    await seed(5, [A]);
    const rows = await claimOutboxBatch(worker, { workerId: W });
    const k = keys(rows);
    expect(await markPublished(worker, k, "intruder")).toBe(0);
    expect(await releaseClaims(worker, k.slice(0, 2), "intruder")).toBe(0);
    expect(await releaseClaims(worker, k.slice(0, 2), W)).toBe(2);
    expect(await claimOutboxBatch(worker, { workerId: "w2" })).toHaveLength(2);
    expect(await markPublished(worker, k.slice(2), W)).toBe(3);
    expect(await markPublished(worker, k.slice(2), W)).toBe(0);
    expect(await markPublished(worker, [], W)).toBe(0);
    expect(await releaseClaims(worker, [], W)).toBe(0);
    const pub = await sql<{ claimed_until: Date | null }>(
      "select claimed_until from infra.outbox where published_at is not null",
    );
    expect(pub.every((r) => r.claimed_until === null)).toBe(true);
  });
});

describe("prune", () => {
  it("pruneOutbox deletes only old published rows, in batches", async () => {
    await seed(10, [A]);
    await worker.query(
      `update infra.outbox set published_at = now() - interval '8 days'
        where id in (select id from infra.outbox order by id limit 4)`,
    );
    await worker.query(
      `update infra.outbox set published_at = now() - interval '1 day'
        where id in (select id from infra.outbox where published_at is null order by id limit 2)`,
    );
    expect(await pruneOutbox(worker, { batch: 3 })).toBe(4);
    expect(Number((await sql<{ n: string }>("select count(*) n from infra.outbox"))[0]?.n)).toBe(6);
  });

  it("pruneProcessedEvents deletes only old rows", async () => {
    await worker.query("delete from infra.processed_events");
    await worker.query(
      `insert into infra.processed_events (tenant_id, consumer, event_id, processed_at)
       values ($1,'p',$2, now() - interval '31 days'), ($1,'p',$3, now())`,
      [A, uuid7(), uuid7()],
    );
    expect(await pruneProcessedEvents(worker)).toBe(1);
    expect(
      Number((await sql<{ n: string }>("select count(*) n from infra.processed_events"))[0]?.n),
    ).toBe(1);
  });
});

describe("consumer tables", () => {
  const eventId = uuid7();
  it("recordProcessed is true once per (consumer, tenant, event)", async () => {
    const p = { tenantId: A, consumer: "c1", eventId };
    expect(await recordProcessed(worker, p)).toBe(true);
    expect(await recordProcessed(worker, p)).toBe(false);
    expect(await recordProcessed(worker, { ...p, consumer: "c2" })).toBe(true);
  });

  it("tenants sharing an event id are processed independently", async () => {
    const x = uuid7();
    await seed(0, []);
    for (const t of [A, B])
      await withTenantTx(app, ctx(t), (tx) => appendOutbox(tx, [event({ id: x })]));
    const rows = await claimOutboxBatch(worker, { workerId: W });
    expect(rows.map((r) => r.tenantId).sort()).toEqual([A, B].sort());
    for (const r of rows)
      expect(
        await recordProcessed(worker, { tenantId: r.tenantId, consumer: "cx", eventId: r.id }),
      ).toBe(true);
    for (const t of [A, B])
      expect(
        await recordDeadLetter(worker, {
          tenantId: t,
          consumer: "cx",
          eventId: x,
          error: "e",
          attempts: 1,
          payload: {},
        }),
      ).toBe(true);
  });

  it("recordDeadLetter strips NUL/control chars, first line, 1000 chars; re-park updates", async () => {
    const p = {
      tenantId: A,
      consumer: "c9",
      eventId: uuid7(),
      error: `a\u0000b\u0007c\td${"x".repeat(3000)}\n    at stack`,
      attempts: 3,
      payload: { z: 1 },
    };
    expect(await recordDeadLetter(worker, p)).toBe(true);
    expect(await recordDeadLetter(worker, { ...p, attempts: 4, error: "again" })).toBe(false);
    const r = await sql<{ error: string; attempts: number }>(
      "select error, attempts from infra.dead_letters where event_id = $1 and consumer = 'c9'",
      [p.eventId],
    );
    expect(r).toEqual([{ error: "again", attempts: 4 }]);
    await recordDeadLetter(worker, { ...p, eventId: uuid7() });
    const long = await sql<{ error: string }>(
      "select error from infra.dead_letters where consumer = 'c9' and error like 'abc%'",
    );
    expect(long[0]?.error).toHaveLength(1000);
    expect(long[0]?.error.startsWith("abc\td")).toBe(true);
    await recordDeadLetter(worker, { ...p, eventId: uuid7(), error: "" });
    await worker.query("delete from infra.dead_letters");
  });

  it("migrator (owner) is still blocked by forced RLS", async () => {
    const r = await migrator.query("select 1 from infra.outbox");
    expect(r.rowCount).toBe(0);
  });
});
