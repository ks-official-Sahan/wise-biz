import { createRoute, z } from "@hono/zod-openapi";

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

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

export function mountHealth(
  app: OpenAPIHono<AppEnv>,
  deps: { pool: Pick<pg.Pool, "query">; redis: RedisLike; timeoutMs?: number },
): void {
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  app.openapi(healthRoute, (c) => c.json({ status: "ok" as const }, 200));
  app.openapi(readyRoute, async (c) => {
    const [db, redis] = await Promise.all([
      probe(() => deps.pool.query("select 1"), timeoutMs),
      probe(() => deps.redis.ping(), timeoutMs),
    ]);
    const checks = { db, redis };
    return db === "ok" && redis === "ok"
      ? c.json({ status: "ready" as const, checks }, 200)
      : c.json({ status: "unavailable" as const, checks }, 503);
  });
}
