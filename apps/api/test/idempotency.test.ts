import { join } from "node:path";

import { createPool, instrumentPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { templateModule } from "@wise-biz/module-template";
import { startRedis, testDatabase } from "@wise-biz/testing/containers";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.ts";
import { redisIdempotencyCache } from "../src/idempotency-cache.ts";
import { createLogger } from "../src/logger.ts";

import { baseEnv, headerAuth, okRedis } from "./helpers.ts";

import type { RedisKv } from "../src/idempotency-cache.ts";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "@wise-biz/module-kit";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const ITEMS = "/v1/template/items";
const infraDir = join(import.meta.dirname, "..", "..", "..", "modules", "infra", "migrations");
const auditDir = join(import.meta.dirname, "..", "..", "..", "modules", "audit", "migrations");

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Pool;
let stopRedis: () => Promise<void>;
let redis: ReturnType<typeof createClient>;
let app: OpenAPIHono<AppEnv>;
let downApp: OpenAPIHono<AppEnv>;
let deadRedis: ReturnType<typeof createClient>;
let deadCache: ReturnType<typeof redisIdempotencyCache>;

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: infraDir },
    { module: "audit", dir: auditDir },
    { module: "_template", dir: templateModule.migrationsDir },
  ]);
  pool = createPool(db.url("app"), { max: 20 });
  instrumentPool(pool);
  admin = createPool(db.url("migrator"));
  const r = await startRedis();
  stopRedis = () => r.stop();
  redis = createClient({ url: r.url, disableOfflineQueue: true });
  await redis.connect();
  const logger = createLogger("silent");
  const base = {
    modules: [templateModule],
    pool,
    redis: okRedis,
    env: baseEnv,
    auth: headerAuth,
    logger,
  };
  app = createApp({ ...base, idempotencyCache: redisIdempotencyCache(redis, logger) });
  // Nothing listens on port 1: never connects, offline queue disabled -> every command rejects at once.
  deadRedis = createClient({
    url: "redis://127.0.0.1:1",
    disableOfflineQueue: true,
    socket: { reconnectStrategy: false },
  });
  deadRedis.on("error", () => undefined);
  deadCache = redisIdempotencyCache(deadRedis, logger);
  downApp = createApp({ ...base, idempotencyCache: deadCache });
});
afterAll(async () => {
  deadRedis.destroy();
  await redis.close();
  await stopRedis();
  await pool.end();
  await admin.end();
  await db.drop();
});

const ACTOR = uuidv7();
const hdrs = (tenant: string, key: string): Record<string, string> => ({
  "x-wb-dev-tenant": tenant,
  "x-wb-dev-user": ACTOR, // idempotency keys are actor-scoped
  "content-type": "application/json",
  "idempotency-key": key,
});
const post = (
  a: OpenAPIHono<AppEnv>,
  tenant: string,
  key: string,
  body: unknown,
): Promise<Response> =>
  Promise.resolve(
    a.request(ITEMS, { method: "POST", headers: hdrs(tenant, key), body: JSON.stringify(body) }),
  );
const countItems = (tenant: string): Promise<number> =>
  withTenantTx(admin, { tenantId: tenant, requestId: "test" }, async (tx) =>
    Number((await tx.query<{ n: string }>("select count(*) n from template.items")).rows[0]?.n),
  );

describe("idempotency with real Redis + Postgres", () => {
  it("a different user of the same tenant never replays your response", async () => {
    const t = uuidv7();
    const key = `k-${uuidv7()}`;
    const a = await post(app, t, key, { name: "Mine" });
    const other = await app.request(ITEMS, {
      method: "POST",
      headers: { ...hdrs(t, key), "x-wb-dev-user": uuidv7() },
      body: JSON.stringify({ name: "Mine" }),
    });
    expect(a.status).toBe(201);
    expect(other.status).toBe(201);
    expect(other.headers.get("idempotency-replayed")).toBeNull();
    expect(await countItems(t)).toBe(2);
  });

  it("caches the completed response and replays it from Redis", async () => {
    const t = uuidv7();
    const key = `k-${uuidv7()}`;
    const a = await post(app, t, key, { name: "Mug" });
    expect(a.status).toBe(201);
    const cached = await redis.get(`idem:${t}:${ACTOR}:${key}`);
    expect(cached).not.toBeNull();
    const ttl = await redis.pTTL(`idem:${t}:${ACTOR}:${key}`);
    expect(ttl).toBeGreaterThan(23 * 3600 * 1000);

    // Remove the durable key: only Redis can answer now, and nothing new is written.
    await withTenantTx(admin, { tenantId: t, requestId: "test" }, (tx) =>
      tx.query("delete from infra.idempotency_keys"),
    );
    const b = await post(app, t, key, { name: "Mug" });
    expect(b.headers.get("idempotency-replayed")).toBe("true");
    expect(await b.json()).toEqual(await a.json());
    expect(await countItems(t)).toBe(1);

    const c = await post(app, t, key, { name: "Other" });
    expect(c.status).toBe(422);
    expect(((await c.json()) as { code: string }).code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("10 parallel duplicates create one item", async () => {
    const t = uuidv7();
    const key = `k-${uuidv7()}`;
    const res = await Promise.all(
      Array.from({ length: 10 }, () => post(app, t, key, { name: "P" })),
    );
    // Byte-identical, not just JSON-equal: replays send the stored text verbatim.
    const bodies = await Promise.all(res.map((r) => r.text()));
    expect(res.every((r) => r.status === 201)).toBe(true);
    for (const b of bodies) expect(b).toBe(bodies[0]);
    expect(res.filter((r) => r.headers.get("idempotency-replayed") === "true")).toHaveLength(9);
    expect(await countItems(t)).toBe(1);
  });

  it("replays from Postgres with the exact bytes of the first response", async () => {
    const t = uuidv7();
    const key = `k-${uuidv7()}`;
    const first = await post(app, t, key, { name: "Exact" });
    await redis.del(`idem:${t}:${ACTOR}:${key}`); // force the Postgres path
    const again = await post(app, t, key, { name: "Exact" });
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(await again.text()).toBe(await first.text());
  });

  it("Redis unreachable: request still succeeds and stays idempotent via Postgres", async () => {
    const t = uuidv7();
    const key = `k-${uuidv7()}`;
    const a = await post(downApp, t, key, { name: "R" });
    const b = await post(downApp, t, key, { name: "R" });
    expect(a.status).toBe(201);
    expect(await b.json()).toEqual(await a.json());
    expect(b.headers.get("idempotency-replayed")).toBe("true");
    expect(await countItems(t)).toBe(1);
    expect(deadCache.errors()).toBeGreaterThan(0);
  });
});

describe("redisIdempotencyCache", () => {
  it("swallows errors, counts them, and logs only the first and every 100th", async () => {
    const warn = vi.fn();
    const failing: RedisKv = {
      get: () => Promise.reject(new Error("x")),
      set: () => Promise.reject(new Error("x")),
    };
    const cache = redisIdempotencyCache(failing, { warn } as never);
    for (let i = 0; i < 101; i++) expect(await cache.get("k")).toBeNull();
    await cache.set("k", "v", 1000);
    expect(cache.errors()).toBe(102);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("times out a hung redis command (200 ms) and reports it via the metrics hook", async () => {
    const hang = (): Promise<never> => new Promise(() => undefined);
    const hung: RedisKv = { get: hang, set: hang };
    const metrics: [string, number, Record<string, string>][] = [];
    const cache = redisIdempotencyCache(hung, { warn: vi.fn() } as never, {
      onMetric: (name, value, labels) => metrics.push([name, value, labels]),
    });
    const t0 = Date.now();
    expect(await cache.get("k")).toBeNull();
    await cache.set("k", "v", 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(cache.errors()).toBe(2);
    expect(metrics).toEqual([
      ["idempotency_cache_error", 1, { op: "get" }],
      ["idempotency_cache_error", 1, { op: "set" }],
    ]);
  });
});
