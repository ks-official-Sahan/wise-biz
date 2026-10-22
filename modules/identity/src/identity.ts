import { isUuidv7, uuidv7 } from "@wise-biz/ids";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzle } from "drizzle-orm/node-postgres";

import { checkPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./password-policy.ts";
import * as schema from "./schema.ts";

import type pg from "pg";

export interface IdentitySession {
  sessionId: string;
  userId: string;
  activeTenantId: string | null;
  expiresAt: Date;
}

export interface IdentityPort {
  getSession(headers: Headers): Promise<IdentitySession | null>;
  /** Matches the session on id AND owner, so one user can never move another user's session. */
  setActiveTenant(sessionId: string, userId: string, tenantId: string | null): Promise<void>;
  /** Better Auth handler, mounted at /v1/auth/*. */
  handler(req: Request): Promise<Response>;
}

export interface CreateIdentityOptions {
  /** Pool connected as wb_identity (the only role with access to the identity schema). */
  pool: pg.Pool;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
}

export const SESSION_COOKIE_NAME = "__Host-wb_session";
export const AUTH_BASE_PATH = "/v1/auth";
/**
 * The ONLY header Better Auth reads the client IP from (sessions.ip_address). The API kernel overwrites it with the
 * IP it derived under TRUST_PROXY_HOPS and strips any client-sent value, so the stored address is not spoofable.
 */
export const CLIENT_IP_HEADER = "x-wb-client-ip";

const SESSION_EXPIRES_IN_SECONDS = 12 * 60 * 60;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60;

// Paths whose body carries a new password to be checked against the policy.
const PASSWORD_FIELD_BY_PATH: Readonly<Record<string, string>> = {
  "/sign-up/email": "password",
  "/change-password": "newPassword",
  "/reset-password": "newPassword",
};

export function createIdentity(opts: CreateIdentityOptions): IdentityPort {
  const db = drizzle(opts.pool, { schema });

  const auth = betterAuth({
    appName: "wise-biz",
    baseURL: opts.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: opts.secret,
    // A wildcard would let any site pass Better Auth's own CSRF check; never forward one.
    trustedOrigins: opts.trustedOrigins.filter((o) => o !== "*"),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        users: schema.users,
        sessions: schema.sessions,
        accounts: schema.accounts,
        verifications: schema.verifications,
      },
    }),
    user: { modelName: "users" },
    session: {
      modelName: "sessions",
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false },
      additionalFields: {
        // Written only by IdentityPort.setActiveTenant, never by a client.
        activeTenantId: { type: "string", required: false, input: false },
      },
    },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    // The kernel rate-limits sign-in/sign-up (Redis, fail closed).
    rateLimit: { enabled: false },
    advanced: {
      database: { generateId: () => uuidv7() },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // false: Better Auth must not prepend "__Secure-" (it would yield "__Secure-__Host-..."). The Secure attribute
      // is forced below instead.
      useSecureCookies: false,
      cookies: {
        session_token: {
          name: SESSION_COOKIE_NAME,
          attributes: { secure: true, httpOnly: true, sameSite: "strict", path: "/" },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware((ctx) => {
        const field = PASSWORD_FIELD_BY_PATH[ctx.path];
        if (field === undefined) return Promise.resolve();
        const body = ctx.body as Record<string, unknown> | undefined;
        const password = body?.[field];
        if (typeof password !== "string") return Promise.resolve(); // schema validation reports the shape error
        const email = typeof body?.email === "string" ? body.email : null;
        const name = typeof body?.name === "string" ? body.name : null;
        const check = checkPassword(password, { email, name });
        if (!check.ok) {
          return Promise.reject(
            new APIError("BAD_REQUEST", {
              code: "WEAK_PASSWORD",
              message: check.problems.join(" "),
            }),
          );
        }
        return Promise.resolve();
      }),
    },
  });

  return {
    async getSession(headers) {
      let result;
      try {
        result = await auth.api.getSession({ headers });
      } catch (err) {
        // A missing/tampered/invalid cookie is a client error (4xx APIError) -> no session. Anything else (pool or
        // driver failure, bug) is infrastructure: rethrow so the caller answers 5xx and NEVER treats it as anonymous.
        if (err instanceof APIError && err.statusCode < 500) return null;
        throw err;
      }
      if (!result) return null;
      const s = result.session as typeof result.session & { activeTenantId?: unknown };
      if (s.expiresAt.getTime() <= Date.now()) return null;
      return {
        sessionId: s.id,
        userId: s.userId,
        activeTenantId: isUuidv7(s.activeTenantId) ? s.activeTenantId : null,
        expiresAt: s.expiresAt,
      };
    },
    async setActiveTenant(sessionId, userId, tenantId) {
      await opts.pool.query(
        "UPDATE identity.sessions SET active_tenant_id = $2, updated_at = now() WHERE id = $1 AND user_id = $3",
        [sessionId, tenantId, userId],
      );
    },
    handler: (req) => auth.handler(req),
  };
}
