import { createMemoryBus, createPgBus, defineConsumer } from "@wise-biz/events";
import { uuidv7 } from "@wise-biz/ids";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRelay } from "../src/relay.ts";
import { startWorker } from "../src/worker.ts";

import {
  processedCount,
  seedOutbox,
  setupDb,
  silentLogger,
  unpublished,
  until,
} from "./helpers.ts";

import type { Db } from "./helpers.ts";
import type { EventBus } from "@wise-biz/events";

let db: Db;
beforeAll(async () => {
  db = await setupDb();
});
afterAll(async () => {
  await db.drop();
});

function counting(name: string) {
  const counts = new Map<string, number>();
  const consumer = defineConsumer({
    name,
    events: ["test.thing.happened@v1"],
    handle: (e) => {
      counts.set(e.id, (counts.get(e.id) ?? 0) + 1);
      return Promise.resolve();
    },
  });
  return { counts, consumer };
}

function pgBus(): EventBus {
  return createPgBus({
    pool: db.worker,
    logger: silentLogger,
    backoff: { sleep: () => Promise.resolve() },
  });
}

function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error("missing element");
  return v;
}

describe("relay", () => {
  it("end to end: 3 appended events are handled once and marked published", async () => {
    const tenant = uuidv7();
    const { counts, consumer } = counting("e2e.counter");
    const bus = pgBus();
    bus.subscribe(consumer);
    const ids = await seedOutbox(db.app, tenant, 3);
    const relay = createRelay({ pool: db.worker, bus, logger: silentLogger });
    expect(await unpublished(db.admin, tenant)).toBe(3);
    expect(await relay.tick()).toBe(3);
    expect([...counts.keys()].sort()).toEqual([...ids].sort());
    expect([...counts.values()]).toEqual([1, 1, 1]);
    expect(await unpublished(db.admin, tenant)).toBe(0);
    expect(await relay.tick()).toBe(0);
    expect(await processedCount(db.admin, "e2e.counter")).toBe(3);
  });

  it("crash safety: a failing publish leaves rows unpublished (attempts bumped); next tick delivers", async () => {
    const tenant = uuidv7();
    const { counts, consumer } = counting("crash.counter");
    const real = pgBus();
    real.subscribe(consumer);
    let fail = true;
    const bus: EventBus = {
      ...real,
      publish: (b) => (fail ? Promise.reject(new Error("broker down")) : real.publish(b)),
    };
    const metrics: string[] = [];
    await seedOutbox(db.app, tenant, 2);
    const relay = createRelay({
      pool: db.worker,
      bus,
      logger: silentLogger,
      onMetric: (n) => metrics.push(n),
    });
    await expect(relay.tick()).rejects.toThrow("broker down");
    expect(await unpublished(db.admin, tenant)).toBe(2);
    const a = await db.admin.query<{ attempts: number }>(
      "select attempts from infra.outbox where tenant_id = $1",
      [tenant],
    );
    expect(a.rows.every((r) => r.attempts === 1)).toBe(true);
    expect(metrics).toContain("relay_error");
    fail = false;
    expect(await relay.tick()).toBe(2);
    expect(counts.size).toBe(2);
    expect(await unpublished(db.admin, tenant)).toBe(0);
  });

  it("loop recovers from publish errors without a hot loop", async () => {
    const tenant = uuidv7();
    const mem = createMemoryBus();
    const { counts, consumer } = counting("loop.counter");
    mem.subscribe(consumer);
    let calls = 0;
    const bus: EventBus = {
      ...mem,
      publish: (b) => (calls++ < 2 ? Promise.reject(new Error("flaky")) : mem.publish(b)),
    };
    await seedOutbox(db.app, tenant, 2);
    const relay = createRelay({ pool: db.worker, bus, logger: silentLogger, idleMs: 10 });
    relay.start();
    await until(async () => (await unpublished(db.admin, tenant)) === 0);
    await relay.stop();
    expect(calls).toBe(3);
    expect(counts.size).toBe(2);
  });

  it("two concurrent relays on 1000 rows handle every event exactly once", async () => {
    const tenant = uuidv7();
    const { counts, consumer } = counting("conc.counter");
    const b1 = pgBus();
    const b2 = pgBus();
    b1.subscribe(consumer);
    b2.subscribe(consumer);
    const ids = await seedOutbox(db.app, tenant, 1000);
    const r1 = createRelay({
      pool: db.worker,
      bus: b1,
      logger: silentLogger,
      batchSize: 100,
      idleMs: 10,
    });
    const r2 = createRelay({
      pool: db.worker,
      bus: b2,
      logger: silentLogger,
      batchSize: 100,
      idleMs: 10,
    });
    r1.start();
    r2.start();
    await until(async () => (await unpublished(db.admin, tenant)) === 0);
    await Promise.all([r1.stop(), r2.stop()]);
    expect(counts.size).toBe(1000);
    expect(new Set(counts.keys())).toEqual(new Set(ids));
    expect([...counts.values()].every((v) => v === 1)).toBe(true);
    expect(await processedCount(db.admin, "conc.counter")).toBe(1000);
  });

  it("stop() waits for the in-flight batch", async () => {
    const tenant = uuidv7();
    await seedOutbox(db.app, tenant, 2);
    let release!: () => void;
    let entered!: () => void;
    const inPublish = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    const bus: EventBus = {
      publish: async (b) => {
        entered();
        await gate;
        return { delivered: b.map((e) => ({ tenantId: e.tenantId, id: e.id })), failed: [] };
      },
      subscribe: () => undefined,
      stop: () => Promise.resolve(),
    };
    const relay = createRelay({ pool: db.worker, bus, logger: silentLogger, idleMs: 10 });
    relay.start();
    await inPublish;
    let stopped = false;
    const stopping = relay.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(await unpublished(db.admin, tenant)).toBe(0);
  });
});

describe("relay robustness", () => {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a failing claim surfaces the error and counts relay_error", async () => {
    const pool = { query: () => Promise.reject(new Error("conn lost")) } as unknown as pg.Pool;
    const metrics: string[] = [];
    const relay = createRelay({
      pool,
      bus: createMemoryBus(),
      logger: silentLogger,
      onMetric: (n) => metrics.push(n),
    });
    await expect(relay.tick()).rejects.toThrow("conn lost");
    expect(metrics).toEqual(["relay_error"]);
  });

  it("never holds a transaction during publish and survives a slow batch past idle_in_transaction timeout", async () => {
    const tenant = uuidv7();
    await seedOutbox(db.app, tenant, 3);
    const pool = new pg.Pool({
      connectionString: db.workerUrl,
      max: 4,
      options: "-c idle_in_transaction_session_timeout=1000",
    });
    let release!: () => void;
    let entered!: () => void;
    const inPublish = new Promise<void>((r) => (entered = r));
    const gate = new Promise<void>((r) => (release = r));
    const bus: EventBus = {
      publish: async (b) => {
        entered();
        await gate;
        return { delivered: b.map((e) => ({ tenantId: e.tenantId, id: e.id })), failed: [] };
      },
      subscribe: () => undefined,
      stop: () => Promise.resolve(),
    };
    const relay = createRelay({ pool, bus, logger: silentLogger });
    const ticking = relay.tick();
    await inPublish;
    await sleepMs(2500); // > idle_in_transaction timeout
    const open = await db.admin.query<{ state: string }>(
      "select state from pg_stat_activity where usename = 'wb_worker' and state like 'idle in transaction%'",
    );
    expect(open.rows).toEqual([]);
    release();
    expect(await ticking).toBe(3);
    expect(await unpublished(db.admin, tenant)).toBe(0);
    await pool.end();
  });

  it("releases the claim on publish error so the next tick retries at once", async () => {
    const tenant = uuidv7();
    await seedOutbox(db.app, tenant, 1);
    let fail = true;
    const bus: EventBus = {
      publish: (b) =>
        fail
          ? Promise.reject(new Error("broker down"))
          : Promise.resolve({
              delivered: b.map((e) => ({ tenantId: e.tenantId, id: e.id })),
              failed: [],
            }),
      subscribe: () => undefined,
      stop: () => Promise.resolve(),
    };
    const relay = createRelay({ pool: db.worker, bus, logger: silentLogger, leaseMs: 600_000 });
    await expect(relay.tick()).rejects.toThrow("broker down");
    const row = await db.admin.query<{ claimed_until: Date | null }>(
      "select claimed_until from infra.outbox where tenant_id = $1",
      [tenant],
    );
    expect(row.rows[0]?.claimed_until).toBeNull();
    fail = false;
    expect(await relay.tick()).toBe(1);
  });

  it("an expired lease (crash mid-publish) is redelivered; consumers dedupe", async () => {
    const tenant = uuidv7();
    const { counts, consumer } = counting("lease.counter");
    const bus = pgBus();
    bus.subscribe(consumer);
    await seedOutbox(db.app, tenant, 2);
    const crashed = createRelay({
      pool: db.worker,
      bus: {
        publish: () => new Promise(() => undefined),
        subscribe: () => undefined,
        stop: () => Promise.resolve(),
      },
      logger: silentLogger,
      leaseMs: 1000,
    });
    void crashed.tick(); // claims, then hangs forever = dead worker
    await sleepMs(200);
    const other = createRelay({ pool: db.worker, bus, logger: silentLogger, leaseMs: 1000 });
    expect(await other.tick()).toBe(0); // lease still live
    await sleepMs(1100);
    expect(await other.tick()).toBe(2);
    expect([...counts.values()]).toEqual([1, 1]);
  });

  it("quarantines a poison row (handler and dead-letter both failing) and the queue continues", async () => {
    const tenant = uuidv7();
    const real = db.worker;
    const pool = {
      query: real.query.bind(real),
      connect: async () => {
        const c = await real.connect();
        const q = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        c.query = ((text: unknown, ...rest: unknown[]) =>
          typeof text === "string" && text.includes("infra.dead_letters")
            ? Promise.reject(new Error("dl down"))
            : q(text, ...rest)) as typeof c.query;
        return c;
      },
    } as unknown as pg.Pool;
    const bus = createPgBus({
      pool,
      logger: silentLogger,
      backoff: { sleep: () => Promise.resolve() },
    });
    const seen = new Set<string>();
    bus.subscribe(
      defineConsumer({
        name: "poison.counter",
        events: ["test.thing.happened@v1"],
        maxAttempts: 1,
        handle: (e) =>
          (e.payload as { i: number }).i === 0
            ? Promise.reject(new Error("poison"))
            : (seen.add(e.id), Promise.resolve()),
      }),
    );
    const ids = await seedOutbox(db.app, tenant, 2); // i = 0 is poison
    const metrics: string[] = [];
    const warns: object[] = [];
    const relay = createRelay({
      pool,
      bus,
      logger: { ...silentLogger, warn: (o) => warns.push(o) },
      maxAttempts: 3,
      onMetric: (n) => metrics.push(n),
    });
    await expect(relay.tick()).rejects.toThrow(/failed/); // good event published, poison released
    expect(seen.has(at(ids, 1))).toBe(true);
    await expect(relay.tick()).rejects.toThrow(/failed/);
    await expect(relay.tick()).rejects.toThrow(/failed/);
    expect(await relay.tick()).toBe(0); // exhausted: not claimable any more
    expect(await relay.quarantine()).toBe(1);
    expect(metrics).toContain("relay_quarantined");
    expect(JSON.stringify(warns)).toContain(tenant);
    expect(JSON.stringify(warns)).toContain(at(ids, 0));
    expect(JSON.stringify(warns)).not.toContain("poison");
    const q = await db.admin.query(
      "select 1 from infra.outbox where tenant_id = $1 and quarantined_at is not null and published_at is null",
      [tenant],
    );
    expect(q.rowCount).toBe(1);
    // queue continues: new good event is relayed even though the old poison row stays quarantined
    const later = await seedOutbox(db.app, tenant, 2);
    seen.clear();
    const relay2 = createRelay({ pool, bus, logger: silentLogger, maxAttempts: 3 });
    await expect(relay2.tick()).rejects.toThrow(/failed/); // new poison (i = 0), not the quarantined one
    expect(seen.has(at(later, 1))).toBe(true);
    expect(seen.has(at(ids, 0))).toBe(false);
  });

  it("loop survives errors, throwing hooks and stops promptly during backoff", async () => {
    const tenant = uuidv7();
    await seedOutbox(db.app, tenant, 1);
    let calls = 0;
    const bus: EventBus = {
      publish: (b) => {
        calls++;
        return Promise.reject(new Error(`always ${String(b.length)}`));
      },
      subscribe: () => undefined,
      stop: () => Promise.resolve(),
    };
    const relay = createRelay({
      pool: db.worker,
      bus,
      logger: silentLogger,
      idleMs: 5000,
      onMetric: () => {
        throw new Error("metrics down");
      },
    });
    relay.start();
    relay.start(); // idempotent
    await until(() => Promise.resolve(calls >= 1), 5000);
    await sleepMs(50);
    const t0 = Date.now();
    await relay.stop(); // loop is now in a >= 10 s backoff sleep
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("loop keeps running after a claim error and a throwing hook", async () => {
    const tenant = uuidv7();
    const { counts, consumer } = counting("loopfail.counter");
    const bus = pgBus();
    bus.subscribe(consumer);
    const ids = await seedOutbox(db.app, tenant, 2);
    let n = 0;
    const real = db.worker;
    const pool = {
      query: (...a: unknown[]) =>
        n++ < 2
          ? Promise.reject(new Error("blip"))
          : (real.query as (...x: unknown[]) => Promise<unknown>)(...a),
      connect: () => real.connect(),
    } as unknown as pg.Pool;
    const relay = createRelay({
      pool,
      bus,
      logger: silentLogger,
      idleMs: 10,
      onMetric: () => {
        throw new Error("metrics down");
      },
    });
    relay.start();
    await until(async () => (await unpublished(db.admin, tenant)) === 0);
    await relay.stop();
    expect(ids.every((id) => counts.get(id) === 1)).toBe(true);
  });

  it("maintain() prunes published outbox rows and old processed_events with metrics", async () => {
    const tenant = uuidv7();
    await seedOutbox(db.app, tenant, 2);
    const metrics: [string, number][] = [];
    const relay = createRelay({
      pool: db.worker,
      bus: createMemoryBus(),
      logger: silentLogger,
      onMetric: (n, v) => metrics.push([n, v]),
      retention: { outboxMs: 1, processedMs: 1 },
    });
    await relay.tick();
    await sleepMs(20);
    await relay.maintain();
    expect(metrics.find(([n]) => n === "relay_pruned_outbox")?.[1]).toBeGreaterThanOrEqual(2);
    const left = await db.admin.query("select 1 from infra.outbox where tenant_id = $1", [tenant]);
    expect(left.rowCount).toBe(0);
  });
});

describe("startWorker", () => {
  it("wires env -> pool -> bus -> relay and stops cleanly", async () => {
    const tenant = uuidv7();
    const { counts, consumer } = counting("example.noop");
    const metrics: string[] = [];
    await seedOutbox(db.app, tenant, 2);
    const w = startWorker(
      {
        NODE_ENV: "test",
        LOG_LEVEL: "fatal",
        DATABASE_WORKER_URL: db.workerUrl,
        WORKER_IDLE_MS: "10",
      },
      [consumer],
      (n) => metrics.push(n),
    );
    await until(async () => (await unpublished(db.admin, tenant)) === 0);
    await w.stop();
    expect(counts.size).toBe(2);
    expect(metrics).toEqual(expect.arrayContaining(["processed", "relay_batch", "relay_lag_ms"]));
  });
});
