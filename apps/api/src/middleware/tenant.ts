import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

/** Authenticated user with an active tenant -> tenant context; the request logger is rebound so every line carries tenantId. */
export function tenantResolver(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth.kind === "user" && auth.tenantId !== null) {
      c.set("tenant", {
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: c.get("requestId"),
      });
      c.set("logger", c.get("logger").child({ tenantId: auth.tenantId }));
    } else {
      c.set("tenant", undefined);
    }
    await next();
  };
}
