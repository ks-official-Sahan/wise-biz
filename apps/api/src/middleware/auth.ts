import { isUuidv7 } from "@wise-biz/ids";
import { isTenantRole } from "@wise-biz/policy";

import type { AppEnv, AuthContext } from "@wise-biz/module-kit";
import type { MiddlewareHandler } from "hono";

export interface AuthEnv {
  readonly NODE_ENV: "development" | "test" | "production";
  readonly API_DEV_AUTH: boolean;
}

const ANON: AuthContext = Object.freeze({ kind: "anonymous" });

const csv = (v: string): string[] =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** Dev header auth is honoured only when explicitly enabled AND NODE_ENV is development/test. */
export function devAuthEnabled(env: AuthEnv): boolean {
  return env.API_DEV_AUTH && isDevLike(env.NODE_ENV);
}

/** True only for exactly "development" or "test". Absence or any other value is treated as production. */
export function isDevLike(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}

/** Placeholder until P0-08 (real sessions). Anonymous unless dev auth headers are valid. */
export function authContext(env: AuthEnv): MiddlewareHandler<AppEnv> {
  const dev = devAuthEnabled(env);
  return async (c, next) => {
    let auth: AuthContext = ANON;
    if (dev) {
      const tenantId = c.req.header("x-wb-dev-tenant");
      const userId = c.req.header("x-wb-dev-user");
      if (isUuidv7(tenantId) && isUuidv7(userId)) {
        const roles = csv(c.req.header("x-wb-dev-roles") ?? "owner").filter(isTenantRole);
        const branches = (c.req.header("x-wb-dev-branches") ?? "all").trim();
        auth = {
          kind: "user",
          tenantId,
          userId,
          roles,
          branchScope: branches === "all" ? "all" : csv(branches).filter(isUuidv7),
        };
      }
    }
    c.set("auth", auth);
    await next();
  };
}
