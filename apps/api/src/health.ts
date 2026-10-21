import { createRoute, z } from "@hono/zod-openapi";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

/** How long a /ready result is reused. Bounds probe load to ~1 per second regardless of traffic. */
const READY_CACHE_MS = 1000;

export interface RedisLike {
  ping(): Promise<unknown>;
}

const CHECK_TIMEOUT_MS = 1000;
const Check = z.enum(["ok", "fail"]);

/** Resolves "ok" only when the probe settles successfully within the timeout. Never leaks details. */
async function probe(fn: () => Promise<unknown>, timeoutMs: number): Promise<"ok" | "fail"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = fn().then(() => "ok" as const);
    const timeout = new Promise<"fail">((resolve) => {
      timer = setTimeout(() => {
        resolve("fail");
      }, timeoutMs);
    });
    work.catch(() => undefined); // a probe that loses the race must not become an unhandled rejection
    return await Promise.race([work, timeout]);
  } catch {
    return "fail";
  } finally {
    clearTimeout(timer);
  }
}

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  summary: "Liveness",
  responses: {
    200: {
      description: "Process is up",
      content: { "application/json": { schema: z.object({ status: z.literal("ok") }) } },
    },
  },
});

const readyBody = (status: string) =>
  z.object({ status: z.literal(status), checks: z.object({ db: Check, redis: Check }) });

const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  summary: "Readiness (database and redis)",
  responses: {
    200: {
      description: "Dependencies reachable",
      content: { "application/json": { schema: readyBody("ready") } },
    },
    503: {
      description: "A dependency is unavailable",
      content: { "application/json": { schema: readyBody("unavailable") } },
    },
  },
});

/** pg honours `query_timeout` at runtime but @types/pg omits it from QueryConfig. */
const readyQuery = (timeoutMs: number): pg.QueryConfig & { query_timeout: number } => ({
  text: "select 1",
  query_timeout: timeoutMs,
});

interface Checks {
  db: "ok" | "fail";
  redis: "ok" | "fail";
}

export function mountHealth(
  app: OpenAPIHono<AppEnv>,
  deps: { pool: Pick<pg.Pool, "query">; redis: RedisLike; timeoutMs?: number },
): void {
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  let cached: { at: number; checks: Checks } | undefined;
  let inflight: Promise<Checks> | undefined;

  // Single flight: concurrent callers share one probe; a fresh result is reused for READY_CACHE_MS.
  const check = (): Promise<Checks> => {
    if (cached !== undefined && Date.now() - cached.at < READY_CACHE_MS) {
      return Promise.resolve(cached.checks);
    }
    inflight ??= Promise.all([
      // query_timeout makes pg cancel the client-side wait; the redis client fails fast (no offline queue).
      probe(() => deps.pool.query(readyQuery(timeoutMs)), timeoutMs),
      probe(() => deps.redis.ping(), timeoutMs),
    ])
      .then(([db, redis]) => {
        const checks = { db, redis };
        cached = { at: Date.now(), checks };
        return checks;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  app.openapi(healthRoute, (c) => c.json({ status: "ok" as const }, 200));
  app.openapi(readyRoute, async (c) => {
    const checks = await check();
    return checks.db === "ok" && checks.redis === "ok"
      ? c.json({ status: "ready" as const, checks }, 200)
      : c.json({ status: "unavailable" as const, checks }, 503);
  });
}
