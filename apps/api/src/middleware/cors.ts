import { cors } from "hono/cors";

import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

/** Exact-match allowlist. "*" entries are ignored: credentials are on, so a wildcard is never valid. */
export function corsAllowlist(origins: readonly string[]): MiddlewareHandler<AppEnv> {
  const allowed = new Set(origins.filter((o) => o !== "*"));
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["authorization", "content-type", "idempotency-key", "x-request-id"],
    exposeHeaders: ["x-request-id"],
    maxAge: 600,
  });
}
