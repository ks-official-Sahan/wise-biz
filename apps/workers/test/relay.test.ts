import { createMemoryBus, createPgBus, defineConsumer } from "@wise-biz/events";
import { uuidv7 } from "@wise-biz/ids";
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
      publish: async () => {
        entered();
        await gate;
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

describe("relay with a broken connection", () => {
  it("destroys the connection when ROLLBACK also fails and surfaces the error", async () => {
    const released: unknown[] = [];
    const client = {
      query: () => Promise.reject(new Error("conn lost")),
      release: (e?: unknown) => released.push(e),
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as typeof db.worker;
    const metrics: string[] = [];
    const relay = createRelay({
      pool,
      bus: createMemoryBus(),
      logger: silentLogger,
      onMetric: (n) => metrics.push(n),
    });
    await expect(relay.tick()).rejects.toThrow("conn lost");
    expect(released[0]).toBeInstanceOf(Error);
    expect(metrics).toEqual(["relay_error"]);
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
