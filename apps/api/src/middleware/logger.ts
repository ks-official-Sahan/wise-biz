import { routePath } from "hono/route";

import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";

/** Binds a request-scoped child logger and writes one access line (route template, never raw URL). */
export function requestLogger(root: Logger, clock: { now(): number }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = clock.now();
    c.set("logger", root.child({ requestId: c.get("requestId") }));
    await next();
    const tenant = c.get("tenant");
    c.get("logger").info(
      {
        ...(tenant ? { tenantId: tenant.tenantId } : {}),
        method: c.req.method,
        route: routePath(c, -1),
        status: c.res.status,
        ms: clock.now() - started,
      },
      "request",
    );
  };
}
