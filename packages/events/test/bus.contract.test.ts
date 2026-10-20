import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMemoryBus, createPgBus, defineConsumer } from "../src/index.ts";

import { message, setupDb, silentLogger } from "./helpers.ts";

import type { EventBus, MetricName } from "../src/index.ts";

interface Harness {
  bus: EventBus;
  sleeps: number[];
  metrics: MetricName[];
  deadLetters: () => Promise<{ consumer: string; attempts: number; error: string }[]>;
  processedCount: () => Promise<number | undefined>;
}

let db: Awaited<ReturnType<typeof setupDb>>;
beforeAll(async () => {
  db = await setupDb();
});
afterAll(async () => {
  await db.drop();
});

const tenant = uuidv7();

function common() {
  const sleeps: number[] = [];
  const metrics: MetricName[] = [];
  return {
    sleeps,
    metrics,
    backoff: {
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 1,
    },
    onMetric: (n: MetricName) => metrics.push(n),
  };
}

const adapters: [string, () => Harness][] = [
  [
    "memory",
    () => {
      const c = common();
      const bus = createMemoryBus({ backoff: c.backoff, onMetric: c.onMetric });
      return {
        bus,
        sleeps: c.sleeps,
        metrics: c.metrics,
        deadLetters: () => Promise.resolve(bus.deadLetters.map((d) => ({ ...d }))),
        processedCount: () => Promise.resolve(undefined),
      };
    },
  ],
  [
    "pg",
    () => {
      const c = common();
      const bus = createPgBus({
        pool: db.worker,
        logger: silentLogger,
        backoff: c.backoff,
        onMetric: c.onMetric,
      });
      return {
        bus,
        sleeps: c.sleeps,
        metrics: c.metrics,
        deadLetters: async () =>
          (
            await db.admin.query<{ consumer: string; attempts: number; error: string }>(
              "select consumer, attempts, error from infra.dead_letters where tenant_id = $1",
              [tenant],
            )
          ).rows,
        processedCount: async () =>
          Number(
            (
              await db.admin.query<{ n: string }>(
                "select count(*) n from infra.processed_events where tenant_id = $1 and consumer like 'fail.%'",
                [tenant],
              )
            ).rows[0]?.n,
          ),
      };
    },
  ],
];

describe.each(adapters)("EventBus contract: %s", (_name, make) => {
  it("routes by exact and wildcard patterns only", async () => {
    const { bus } = make();
    const seen: string[] = [];
    const rec = (n: string) => (e: { type: string; version: number }) => {
      seen.push(`${n}:${e.type}@${String(e.version)}`);
      return Promise.resolve();
    };
    bus.subscribe(
      defineConsumer({
        name: `route.exact-${uuidv7()}`,
        events: ["test.thing.happened@v1"],
        handle: rec("exact"),
      }),
    );
    bus.subscribe(
      defineConsumer({
        name: `route.wild-${uuidv7()}`,
        events: ["test.thing.happened@*"],
        handle: rec("wild"),
      }),
    );
    await bus.publish([
      message(tenant),
      message(tenant, { version: 2 }),
      message(tenant, { type: "test.other.happened" }),
    ]);
    expect(seen.sort()).toEqual([
      "exact:test.thing.happened@1",
      "wild:test.thing.happened@1",
      "wild:test.thing.happened@2",
    ]);
  });

  it("handles a redelivered batch once per consumer", async () => {
    const { bus, metrics } = make();
    const counts = new Map<string, number>();
    for (const n of ["dup.a", "dup.b"]) {
      const name = `${n}-${uuidv7()}`;
      bus.subscribe(
        defineConsumer({
          name,
          events: ["test.thing.happened@v1"],
          handle: (e) => {
            counts.set(`${name}${e.id}`, (counts.get(`${name}${e.id}`) ?? 0) + 1);
            return Promise.resolve();
          },
        }),
      );
    }
    const batch = [message(tenant), message(tenant)];
    await bus.publish(batch);
    await bus.publish(batch);
    expect(counts.size).toBe(4);
    expect([...counts.values()].every((v) => v === 1)).toBe(true);
    expect(metrics.filter((m) => m === "duplicate")).toHaveLength(4);
  });

  it("retries a flaky handler with exponential backoff", async () => {
    const { bus, sleeps, metrics, deadLetters } = make();
    const attempts: number[] = [];
    let done = 0;
    bus.subscribe(
      defineConsumer({
        name: `flaky-${uuidv7()}`,
        events: ["test.thing.happened@v1"],
        handle: (_e, ctx) => {
          attempts.push(ctx.attempt);
          if (ctx.attempt < 3) return Promise.reject(new Error("boom"));
          done++;
          return Promise.resolve();
        },
      }),
    );
    await bus.publish([message(tenant)]);
    expect(attempts).toEqual([1, 2, 3]);
    expect(done).toBe(1);
    expect(sleeps).toEqual([100, 200]); // random()=1 -> full delay
    expect(metrics.filter((m) => m === "retry")).toHaveLength(2);
    expect(await deadLetters()).toEqual([]);
  });

  it("dead-letters after maxAttempts and keeps processing the batch and other consumers", async () => {
    const { bus, deadLetters, processedCount, metrics } = make();
    const name = `fail.${uuidv7()}`;
    const good: string[] = [];
    const bad = message(tenant, { payload: { poison: true } });
    const ok = message(tenant);
    bus.subscribe(
      defineConsumer({
        name,
        events: ["test.thing.happened@v1"],
        handle: (e) =>
          (e.payload as { poison?: boolean }).poison
            ? Promise.reject(new Error("x".repeat(2000)))
            : Promise.resolve(),
      }),
    );
    bus.subscribe(
      defineConsumer({
        name: `good-${uuidv7()}`,
        events: ["test.thing.happened@v1"],
        handle: (e) => {
          good.push(e.id);
          return Promise.resolve();
        },
      }),
    );
    await bus.publish([bad, ok]);
    expect(good).toEqual([bad.id, ok.id]);
    const dl = (await deadLetters()).filter((d) => d.consumer === name);
    expect(dl).toHaveLength(1);
    expect(dl[0]?.attempts).toBe(3);
    expect(dl[0]?.error.length).toBeLessThanOrEqual(1000);
    expect(metrics).toContain("dead_letter");
    const processed = await processedCount();
    if (processed !== undefined) expect(processed).toBe(1); // only `ok`: failed attempts rolled back
  });

  it("rejects duplicate consumer names and publishes after stop", async () => {
    const { bus } = make();
    const c = defineConsumer({
      name: `once-${uuidv7()}`,
      events: ["test.thing.happened@*"],
      handle: () => Promise.resolve(),
    });
    bus.subscribe(c);
    expect(() => {
      bus.subscribe(c);
    }).toThrow(/duplicate/);
    await bus.stop();
    await expect(bus.publish([message(tenant)])).rejects.toThrow(/stopped/);
  });
});
