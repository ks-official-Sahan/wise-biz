import { secureHeaders } from "hono/secure-headers";

import type { AppEnv } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

/** API serves JSON only: nothing may load or frame. */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    referrerPolicy: "strict-origin-when-cross-origin",
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
  });
}
