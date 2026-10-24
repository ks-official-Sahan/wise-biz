import { DomainError, toProblem } from "@wise-biz/errors";

import { problemResponse } from "../../problem.ts";

import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Machine-to-machine paths (signature-verified, not cookie-authenticated) that skip the origin check.
 * Empty for now; `/v1/webhooks/` is reserved for the first inbound webhook.
 */
export const MACHINE_PATH_PREFIXES: readonly string[] = [];

/**
 * CSRF guard (security.md): an unsafe request that carries a cookie must come from an allowed origin
 * (CORS_ORIGINS) or be same-origin per `Sec-Fetch-Site`; otherwise 403 ORIGIN_REJECTED. Cookie-less requests are not
 * CSRF-able and pass. Browsers always send Origin on unsafe cross-site requests and forbid scripts from setting it.
 */
export function originGuard(
  allowedOrigins: readonly string[],
  machinePaths: readonly string[] = MACHINE_PATH_PREFIXES,
): MiddlewareHandler<AppEnv> {
  const allowed = new Set(allowedOrigins.filter((o) => o !== "*"));
  return async (c, next) => {
    if (!UNSAFE.has(c.req.method)) return next();
    const cookie = c.req.header("cookie");
    if (cookie === undefined || cookie === "") return next();
    if (machinePaths.some((p) => c.req.path.startsWith(p))) return next();

    const origin = c.req.header("origin");
    const sameOrigin = c.req.header("sec-fetch-site") === "same-origin";
    if ((origin !== undefined && allowed.has(origin)) || sameOrigin) return next();
    return problemResponse(
      c,
      toProblem(new DomainError("ORIGIN_REJECTED", "Origin not allowed"), c.get("requestId")),
    );
  };
}
