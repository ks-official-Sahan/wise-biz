import { OpenAPIHono } from "@hono/zod-openapi";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";

import { createErrorHandler, notFoundHandler, validationHook } from "./errors.ts";
import { mountHealth } from "./health.ts";
import { createLogger } from "./logger.ts";
import { authContext } from "./middleware/auth.ts";
import { bodyLimit } from "./middleware/body-limit.ts";
import { corsAllowlist } from "./middleware/cors.ts";
import { requestLogger } from "./middleware/logger.ts";
import { requestId } from "./middleware/request-id.ts";
import { securityHeaders } from "./middleware/security.ts";
import { tenantResolver } from "./middleware/tenant.ts";
import { tracing } from "./middleware/tracing.ts";

import type { RedisLike } from "./health.ts";
import type { AuthEnv } from "./middleware/auth.ts";
import type { AppEnv, WbModule } from "@wise-biz/module-kit";
import type pg from "pg";
import type { Logger } from "pino";

export interface ApiEnv extends AuthEnv {
  readonly CORS_ORIGINS: readonly string[];
  readonly LOG_LEVEL?: string;
}

export interface CreateAppOptions {
  modules: readonly WbModule[];
  pool: pg.Pool;
  redis: RedisLike;
  env: ApiEnv;
  logger?: Logger;
  clock?: { now(): number };
  /** Max request body in bytes (default 1 MiB). */
  bodyLimitBytes?: number;
}

/** Modules that may run in this environment (devOnly ones are skipped in production). */
export function mountableModules(
  modules: readonly WbModule[],
  nodeEnv: ApiEnv["NODE_ENV"],
): WbModule[] {
  return modules.filter((m) => !(m.devOnly === true && nodeEnv === "production"));
}

export function createApp(opts: CreateAppOptions): OpenAPIHono<AppEnv> {
  const { pool, redis, env } = opts;
  const clock = opts.clock ?? { now: Date.now };
  const logger = opts.logger ?? createLogger(env.LOG_LEVEL);
  const modules = mountableModules(opts.modules, env.NODE_ENV);

  // Owner gets every registered module permission; P0-08 replaces this with stored policy rows.
  const catalog = createCatalog(...modules.map((m) => m.permissions));
  const matrix = matrixFromRows(catalog, []);

  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  // Order is part of the contract (docs/prompts/P0/06-api-db-rls.md).
  app.use("*", requestId());
  app.use("*", requestLogger(logger, clock));
  app.use("*", tracing());
  app.use("*", securityHeaders());
  app.use("*", bodyLimit(opts.bodyLimitBytes));
  app.use("*", corsAllowlist(env.CORS_ORIGINS));
  app.use("*", authContext(env));
  app.use("*", tenantResolver());
  app.use("*", policyMiddleware(matrix, clock));

  mountHealth(app, { pool, redis });
  const deps = { pool, clock, ids: { uuidv7 } };
  for (const m of modules) m.routes(app, deps);

  if (env.NODE_ENV !== "production") {
    app.doc31("/openapi.json", openapiInfo);
  }

  app.onError(createErrorHandler(logger));
  app.notFound(notFoundHandler);
  return app;
}

export const openapiInfo = {
  openapi: "3.1.0",
  info: { title: "wise-biz API", version: "1.0.0" },
} as const;
