import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPgBus, defineConsumer } from "../src/index.ts";

import { message, setupDb, silentLogger } from "./helpers.ts";

import type { MetricName } from "../src/index.ts";
import type pg from "pg";

let db: Awaited<ReturnType<typeof setupDb>>;
beforeAll(async () => {
  db = await setupDb();
});
afterAll(async () => {
  await db.drop();
});

const tenant = uuidv7();
const instant = { sleep: () => Promise.resolve() };
const EVENTS = ["test.thing.happened@v1"];

const processed = async (consumer: string): Promise<number> =>
  Number(
    (
      await db.admin.query<{ n: string }>(
        "select count(*) n from infra.processed_events where consumer = $1",
        [consumer],
      )
    ).rows[0]?.n,
  );

describe("pg bus", () => {
  it("scopes the consumer tx to the event tenant (app.tenant_id, app.request_id)", async () => {
    const bus = createPgBus({ pool: db.worker, logger: silentLogger, backoff: instant });
    const seen: string[][] = [];
    bus.subscribe(
      defineConsumer({
        name: `scope-${uuidv7()}`,
        events: EVENTS,
        handle: async (_e, { client }) => {
          const r = await client.query<{ t: string; r: string }>(
            "select current_setting('app.tenant_id', true) t, current_setting('app.request_id', true) r",
          );
          seen.push([r.rows[0]?.t ?? "", r.rows[0]?.r ?? ""]);
        },
      }),
    );
    const other = uuidv7();
    const a = message(tenant);
    const b = message(other);
    await bus.publish([a, b]);
    expect(seen).toEqual([
      [tenant, a.id],
      [other, b.id],
    ]);
  });

  it("a handler that swallows a SQL error is not marked processed and is retried", async () => {
    const name = `swallow-${uuidv7()}`;
    const attempts: number[] = [];
    const bus = createPgBus({ pool: db.worker, logger: silentLogger, backoff: instant });
    bus.subscribe(
      defineConsumer({
        name,
        events: EVENTS,
        handle: async (_e, { client, attempt }) => {
          attempts.push(attempt);
          if (attempt === 1) await client.query("select 1/0").catch(() => undefined);
        },
      }),
    );
    const res = await bus.publish([message(tenant)]);
    expect(attempts).toEqual([1, 2]);
    expect(res.failed).toEqual([]);
    expect(await processed(name)).toBe(1);
  });

  it("times out a hung handler, destroys its connection and dead-letters", async () => {
    const name = `hang-${uuidv7()}`;
    const metrics: MetricName[] = [];
    const bus = createPgBus({
      pool: db.worker,
      logger: silentLogger,
      backoff: instant,
      handlerTimeoutMs: 200,
      onMetric: (n) => metrics.push(n),
    });
    bus.subscribe(
      defineConsumer({
        name,
        events: EVENTS,
        maxAttempts: 2,
        handle: () => new Promise<void>(() => undefined),
      }),
    );
    const t0 = Date.now();
    const res = await bus.publish([message(tenant)]);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(res.failed).toEqual([]);
    expect(metrics).toContain("dead_letter");
    expect(await processed(name)).toBe(0);
    const dl = await db.admin.query<{ error: string }>(
      "select error from infra.dead_letters where consumer = $1",
      [name],
    );
    expect(dl.rows[0]?.error).toMatch(/timed out/);
    // The server drops the destroyed backend asynchronously; poll briefly instead of a single snapshot.
    await expect
      .poll(
        async () => {
          const idle = await db.admin.query<{ n: string }>(
            "select count(*) n from pg_stat_activity where usename = 'wb_worker' and datname = current_database() and state = 'idle in transaction'",
          );
          return Number(idle.rows[0]?.n);
        },
        { timeout: 5_000, interval: 100 },
      )
      .toBe(0);
  });

  it("statement_timeout cancels a slow SQL statement", async () => {
    const name = `slowsql-${uuidv7()}`;
    const bus = createPgBus({
      pool: db.worker,
      logger: silentLogger,
      backoff: instant,
      handlerTimeoutMs: 300,
    });
    bus.subscribe(
      defineConsumer({
        name,
        events: EVENTS,
        maxAttempts: 1,
        handle: async (_e, { client }) => {
          await client.query("select pg_sleep(10)");
        },
      }),
    );
    const t0 = Date.now();
    await bus.publish([message(tenant)]);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await processed(name)).toBe(0);
  });

  it("a throwing onMetric / logger never changes the outcome", async () => {
    const name = `hooks-${uuidv7()}`;
    let handled = 0;
    const bus = createPgBus({
      pool: db.worker,
      logger: {
        info: () => undefined,
        warn: () => {
          throw new Error("log down");
        },
        error: () => {
          throw new Error("log down");
        },
      },
      backoff: instant,
      onMetric: () => {
        throw new Error("metrics down");
      },
    });
    bus.subscribe(
      defineConsumer({
        name,
        events: EVENTS,
        handle: () => {
          handled++;
          return Promise.resolve();
        },
      }),
    );
    bus.subscribe(
      defineConsumer({
        name: `${name}-bad`,
        events: EVENTS,
        maxAttempts: 2,
        handle: () => Promise.reject(new Error("nope")),
      }),
    );
    const m = message(tenant);
    const res = await bus.publish([m]);
    expect(handled).toBe(1);
    expect(res.delivered).toEqual([{ tenantId: tenant, id: m.id }]);
    const dl = await db.admin.query("select 1 from infra.dead_letters where consumer = $1", [
      `${name}-bad`,
    ]);
    expect(dl.rowCount).toBe(1);
    expect(await processed(name)).toBe(1);
  });

  it("reports an event as failed when dead-letter parking fails, and continues the batch", async () => {
    const name = `park-${uuidv7()}`;
    const real = db.worker;
    const pool = {
      connect: async () => {
        const c = await real.connect();
        const query = c.query.bind(c) as (...a: unknown[]) => Promise<unknown>;
        c.query = ((text: unknown, ...rest: unknown[]) =>
          typeof text === "string" && text.includes("infra.dead_letters")
            ? Promise.reject(new Error("dl down"))
            : query(text, ...rest)) as typeof c.query;
        return c;
      },
    } as unknown as pg.Pool;
    const bus = createPgBus({ pool, logger: silentLogger, backoff: instant });
    const good: string[] = [];
    bus.subscribe(
      defineConsumer({
        name,
        events: EVENTS,
        maxAttempts: 1,
        handle: (e) =>
          (e.payload as { poison?: boolean }).poison
            ? Promise.reject(new Error("x"))
            : (good.push(e.id), Promise.resolve()),
      }),
    );
    const bad = message(tenant, { payload: { poison: true } });
    const ok = message(tenant);
    const res = await bus.publish([bad, ok]);
    expect(res.failed).toEqual([{ tenantId: tenant, id: bad.id }]);
    expect(res.delivered).toEqual([{ tenantId: tenant, id: ok.id }]);
    expect(good).toEqual([ok.id]);
  });
});
