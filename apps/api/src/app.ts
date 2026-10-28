import { getConnInfo } from "@hono/node-server/conninfo";
import { OpenAPIHono } from "@hono/zod-openapi";
import { uuidv7 } from "@wise-biz/ids";
import { deviceAuth } from "@wise-biz/module-devices";
import { CLIENT_IP_HEADER } from "@wise-biz/module-identity";
import { setPolicy } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";

import { isDevLike } from "./env-mode.ts";
import { createErrorHandler, notFoundHandler, validationHook } from "./errors.ts";
import { mountHealth } from "./health.ts";
import {
  LIMITS,
  bodyEmail,
  clientIp,
  createPolicyMatrixCache,
  emailDigest,
  ipBucket,
  originGuard,
  rateLimit,
  sha256Hex,
} from "./kernel/auth/index.ts";
import { deviceNonces } from "./kernel/device/nonces.ts";
import { createLogger } from "./logger.ts";
import { bodyLimit } from "./middleware/body-limit.ts";
import { corsAllowlist } from "./middleware/cors.ts";
import { requestLogger } from "./middleware/logger.ts";
import { requestId } from "./middleware/request-id.ts";
import { securityHeaders } from "./middleware/security.ts";
import { tenantResolver } from "./middleware/tenant.ts";
import { tracing } from "./middleware/tracing.ts";

import type { RedisLike } from "./health.ts";
import type { AuthResolver, KernelRedis, PolicyRowsLoader } from "./kernel/auth/index.ts";
import type {
  AppEnv,
  AuthContext,
  IdempotencyCache,
  ModuleDeps,
  WbModule,
} from "@wise-biz/module-kit";
import type { Context, MiddlewareHandler } from "hono";
import type pg from "pg";
import type { Logger } from "pino";

export interface ApiEnv {
  readonly NODE_ENV: "development" | "test" | "production";
  readonly CORS_ORIGINS: readonly string[];
  readonly LOG_LEVEL?: string;
  /** Trusted reverse-proxy hops (client IP for rate limits and sessions.ip_address). 0 = socket peer only. */
  readonly TRUST_PROXY_HOPS?: number;
}

/** The slice of the identity port the app mounts at /v1/auth/*. */
export interface AuthHandler {
  handler(req: Request): Promise<Response>;
}

export interface CreateAppOptions {
  modules: readonly WbModule[];
  pool: pg.Pool;
  redis: RedisLike;
  env: ApiEnv;
  /** Resolves the caller. Production: `sessionResolver`; tests inject a header-based resolver. Required. */
  auth: AuthResolver;
  /** Tenancy policy rows for the per-request matrix (cached by tenant + permissions version). Default: no rows. */
  policyRows?: PolicyRowsLoader;
  /** Redis for the policy cache (read-through) and the sign-in/sign-up/create-business rate limiter (fail closed). */
  kernelRedis?: KernelRedis;
  /** Identity (Better Auth) handler, mounted at /v1/auth/*. Omit to leave /v1/auth unmounted. */
  identity?: AuthHandler;
  logger?: Logger;
  /** Redis-backed (or any) cache of completed idempotent responses; omit to rely on Postgres alone. */
  idempotencyCache?: IdempotencyCache;
  idempotencyTtlMs?: number;
  clock?: { now(): number };
  /** Max request body in bytes (default 1 MiB). */
  bodyLimitBytes?: number;
}

const ANON: AuthContext = Object.freeze({ kind: "anonymous" });

/** Socket peer address when running under @hono/node-server; undefined in tests (app.request). */
function socketIp(c: Context<AppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/** Modules that may run in this environment (devOnly ones are skipped in production). */
export function mountableModules(
  modules: readonly WbModule[],
  nodeEnv: ApiEnv["NODE_ENV"],
): WbModule[] {
  return modules.filter((m) => !(m.devOnly === true && !isDevLike(nodeEnv)));
}

export function createApp(opts: CreateAppOptions): OpenAPIHono<AppEnv> {
  const { pool, redis, env } = opts;
  const clock = opts.clock ?? { now: Date.now };
  const logger = opts.logger ?? createLogger(env.LOG_LEVEL);
  const modules = mountableModules(opts.modules, env.NODE_ENV);

  // Owner gets every registered module permission; other roles come from stored tenancy grants (per tenant).
  const catalog = createCatalog(...modules.map((m) => m.permissions));
  const noGrants = matrixFromRows(catalog, []);
  const policy = createPolicyMatrixCache({
    catalog,
    loadRows: opts.policyRows ?? (() => Promise.resolve([])),
    redis: opts.kernelRedis,
    logger,
  });
  const hops = env.TRUST_PROXY_HOPS ?? 0;
  const trustedIp = (c: Context<AppEnv>): string => clientIp(c, hops, socketIp(c));
  const ipOf = (c: Context<AppEnv>): string => ipBucket(trustedIp(c));

  const app = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });

  // Order is part of the contract (docs/prompts/P0/06-api-db-rls.md).
  app.use("*", requestId());
  app.use("*", requestLogger(logger, clock));
  app.use("*", tracing());
  app.use("*", securityHeaders());
  app.use("*", corsAllowlist(env.CORS_ORIGINS));
  app.use("*", bodyLimit(opts.bodyLimitBytes));
  app.use("*", originGuard(env.CORS_ORIGINS));
  const resolveAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    // /v1/auth/* is Better Auth's own surface: it reads the session itself, so skip our resolver (saves 2 queries).
    c.set("auth", c.req.path.startsWith("/v1/auth/") ? ANON : await opts.auth(c));
    await next();
  };
  const policyContext: MiddlewareHandler<AppEnv> = async (c, next) => {
    const auth = c.get("auth");
    const matrix =
      auth.kind === "user" && auth.tenantId !== null
        ? await policy.matrixFor(auth.tenantId, auth.permissionsVersion, c.get("requestId"))
        : noGrants;
    setPolicy(c, { matrix, now: () => clock.now() });
    await next();
  };
  app.use("*", resolveAuth);
  app.use("*", tenantResolver());
  app.use("*", policyContext);
  // Signed terminal requests (RFC 9421): verified against the enrolled device on every request, nonces in Redis.
  app.use("*", deviceAuth({ pool, nonces: deviceNonces(opts.kernelRedis), clock }));

  // Rate limits: Redis, FAIL CLOSED (503) and ONLY on these writes; reads never touch the limiter.
  const limited = { redis: opts.kernelRedis, method: "POST" } as const;
  app.use(
    "/v1/devices/enroll",
    rateLimit([{ name: "enroll:ip", ...LIMITS.enrollPerIp, subject: ipOf }], limited),
  );
  app.use(
    "/v1/auth/sign-in/*",
    rateLimit(
      [
        { name: "signin:ip", ...LIMITS.signInPerIp, subject: ipOf },
        {
          name: "signin:email",
          ...LIMITS.signInPerEmail,
          subject: async (c) => {
            const email = await bodyEmail(c);
            return email === null ? null : emailDigest(email);
          },
        },
      ],
      limited,
    ),
  );
  app.use(
    "/v1/auth/sign-up/*",
    rateLimit([{ name: "signup:ip", ...LIMITS.signUpPerIp, subject: ipOf }], limited),
  );
  // Every OTHER unsafe auth route (change-password, update-user, revoke-*, sign-out...): per session, per IP without one.
  app.use(
    "/v1/auth/*",
    rateLimit(
      [
        {
          name: "auth-write",
          ...LIMITS.authWritePerSession,
          subject: (c) => {
            if (
              c.req.path.startsWith("/v1/auth/sign-in/") ||
              c.req.path.startsWith("/v1/auth/sign-up/")
            ) {
              return null;
            } // covered above
            const cookie = c.req.header("cookie");
            return cookie === undefined || cookie === ""
              ? `ip:${ipOf(c)}`
              : `session:${sha256Hex(cookie)}`;
          },
        },
        {
          // The cookie is client-chosen, so the session bucket alone can be dodged (for example to mail
          // send-verification-email to any address). Every unsafe auth route also counts per IP.
          name: "auth-write-ip",
          ...LIMITS.authWritePerIp,
          subject: (c) =>
            c.req.path.startsWith("/v1/auth/sign-in/") || c.req.path.startsWith("/v1/auth/sign-up/")
              ? null
              : ipOf(c),
        },
      ],
      { redis: opts.kernelRedis, unsafeOnly: true },
    ),
  );
  app.use(
    "/v1/tenancy/tenants",
    rateLimit(
      [
        {
          name: "create-business:user",
          ...LIMITS.createBusinessPerUser,
          subject: (c) => {
            const auth = c.get("auth");
            return auth.kind === "user" ? auth.userId : null;
          },
        },
      ],
      limited,
    ),
  );
  // Invite acceptance: per signed-in user (guessing tokens needs a session first), fail closed like the others.
  app.use(
    "/v1/tenancy/invites/accept",
    rateLimit(
      [
        {
          name: "accept-invite:user",
          ...LIMITS.acceptInvitePerUser,
          subject: (c) => {
            const auth = c.get("auth");
            return auth.kind === "user" ? auth.userId : null;
          },
        },
      ],
      limited,
    ),
  );
  if (opts.identity) {
    const identity = opts.identity;
    // Better Auth reads the client IP ONLY from CLIENT_IP_HEADER: strip anything the client sent, set the trusted one.
    app.all("/v1/auth/*", (c) => {
      const headers = new Headers(c.req.raw.headers);
      headers.delete(CLIENT_IP_HEADER);
      const ip = trustedIp(c);
      if (ip !== "unknown") headers.set(CLIENT_IP_HEADER, ip);
      return identity.handler(new Request(c.req.raw, { headers }));
    });
  }

  mountHealth(app, { pool, redis });
  const deps: ModuleDeps = {
    pool,
    clock,
    ids: { uuidv7 },
    catalog,
    ...(opts.idempotencyCache && { idempotencyCache: opts.idempotencyCache }),
    ...(opts.idempotencyTtlMs !== undefined && { idempotencyTtlMs: opts.idempotencyTtlMs }),
  };
  for (const m of modules) m.routes(app, deps);

  if (isDevLike(env.NODE_ENV)) {
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
