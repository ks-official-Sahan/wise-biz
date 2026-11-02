import { secureHeaders } from "hono/secure-headers";

import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

/**
 * API serves JSON only: nothing may load or frame. The one HTML surface is the public receipt page (`/r/:code`), which
 * sets its own stricter headers (no scripts, no referrer), so it is left alone here.
 */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  const apiHeaders = secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    referrerPolicy: "strict-origin-when-cross-origin",
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  });
  return async (c, next) => {
    if (c.req.path.startsWith("/r/")) {
      await next();
      c.res.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
      );
      c.res.headers.set("X-Content-Type-Options", "nosniff");
      return;
    }
    await apiHeaders(c, next);
  };
}
