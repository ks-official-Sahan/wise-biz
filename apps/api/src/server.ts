import { serve } from "@hono/node-server";
import { createPool, instrumentPool } from "@wise-biz/db";
import {
  assertProductionEnv,
  authEnv,
  consoleEnv,
  databaseEnv,
  defineEnv,
  httpEnv,
  identityDbEnv,
  inviteEnv,
  pinEnv,
  mailEnv,
  observabilityEnv,
  redisEnv,
  webauthnEnv,
} from "@wise-biz/env";
import { createMailer } from "@wise-biz/mailer";
import { SESSION_COOKIE_NAME, createIdentity } from "@wise-biz/module-identity";
import { createTenancyPorts } from "@wise-biz/module-tenancy";
import { createClient } from "redis";

import { createApp } from "./app.ts";
import { redisIdempotencyCache } from "./idempotency-cache.ts";
import { nodeRedisKernel, sessionResolver } from "./kernel/auth/index.ts";
import { deviceNonces } from "./kernel/device/nonces.ts";
import { createLogger } from "./logger.ts";
import { createModules } from "./modules.ts";

import type { CacheOnMetric } from "./idempotency-cache.ts";
import type { EnvSource } from "@wise-biz/env";
import type { AddressInfo } from "node:net";

const CLOSE_GRACE_MS = 5000;

export const API_ENV = {
  ...databaseEnv,
  ...identityDbEnv,
  ...authEnv,
  ...redisEnv,
  ...observabilityEnv,
  ...httpEnv,
  ...mailEnv,
  ...inviteEnv,
  ...pinEnv,
  ...consoleEnv,
  ...webauthnEnv,
};

export interface RunningServer {
  port: number;
  /** Stop accepting connections, drain, close pool and redis. */
  close(): Promise<void>;
}

/** Validate env, build dependencies, listen. `source` is a parameter so tests never touch process.env. */
export async function startServer(
  source: EnvSource = process.env,
  hooks: { onMetric?: CacheOnMetric } = {},
): Promise<RunningServer> {
  assertProductionEnv(source);
  const env = defineEnv(API_ENV, source);
  const logger = createLogger(env.LOG_LEVEL);
  // Transactional mail (verification, second factor, invites). Sends never block a request: see the callers.
  const mailer = createMailer(env);
  // CORS allowlist without wildcards: the same origins are WebAuthn origins and Better Auth trusted origins.
  const origins = env.CORS_ORIGINS.filter((o) => o !== "*");

  const pool = createPool(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    applicationName: "wb-api",
    onError: (err) => {
      logger.warn({ err }, "idle postgres client error");
    },
  });
  if (env.NODE_ENV !== "production") instrumentPool(pool);
  // Dedicated pool for the identity schema: wb_identity is the only role allowed to touch it (ADR 0010).
  const identityPool = createPool(env.DATABASE_IDENTITY_URL, {
    max: Math.min(env.DATABASE_POOL_MAX, 10),
    applicationName: "wb-api-identity",
    onError: (err) => {
      logger.warn({ err }, "idle identity postgres client error");
    },
  });
  // Fail fast instead of retrying forever silently: readiness reports Redis, the API still serves.
  const REDIS_BOOT_WAIT_MS = 500;
  const redis = createClient({
    url: env.REDIS_URL,
    socket: { connectTimeout: 2000, reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
    disableOfflineQueue: true,
  });
  redis.on("error", (err: unknown) => {
    logger.error({ err }, "redis error");
  });

  const teardown = async (): Promise<void> => {
    try {
      await pool.end();
    } catch {
      // already ended or never connected
    }
    try {
      await identityPool.end();
    } catch {
      // already ended or never connected
    }
    // close() waits for the socket; with Redis lost mid-run the client is reconnecting and close() never settles.
    if (!redis.isReady) {
      try {
        redis.destroy();
      } catch {
        // already closed
      }
    } else {
      try {
        await redis.close();
      } catch {
        redis.destroy();
      }
    }
  };

  try {
    // Not awaited: with an unreachable Redis connect() never settles. The client keeps reconnecting in the background.
    const connecting = redis.connect().catch((err: unknown) => {
      logger.error({ err }, "redis connect failed");
    });
    // Short bounded wait so the first requests after boot do not race the connection (no offline queue: a command
    // sent before `ready` fails, and rate-limited routes answer 503). An unreachable Redis costs at most this wait.
    await Promise.race([
      connecting,
      new Promise((resolve) => setTimeout(resolve, REDIS_BOOT_WAIT_MS)),
    ]);

    const identity = createIdentity({
      pool: identityPool,
      secret: env.AUTH_SECRET,
      baseURL: env.AUTH_URL,
      trustedOrigins: [...env.CORS_ORIGINS],
      mailer,
      consoleUrl: env.CONSOLE_URL,
      rpId: env.AUTH_RP_ID,
      rpOrigins: origins,
    });
    const tenancy = createTenancyPorts(pool);
    const kernelRedis = nodeRedisKernel(redis);
    const app = createApp({
      modules: createModules(
        identity,
        { inviteSecret: env.INVITE_SECRET },
        { nonces: deviceNonces(kernelRedis), pinPepper: env.PIN_PEPPER },
      ),
      pool,
      redis,
      env,
      logger,
      auth: sessionResolver({
        sessions: identity,
        memberships: tenancy,
        cookieName: SESSION_COOKIE_NAME,
      }),
      policyRows: (tenantId, requestId) => tenancy.loadPolicyRows(tenantId, requestId),
      kernelRedis,
      identity,
      idempotencyCache: redisIdempotencyCache(redis, logger, { onMetric: hooks.onMetric }),
    });
    const server = serve({ fetch: app.fetch, port: env.PORT }, (info: AddressInfo) => {
      logger.info({ port: info.port }, "api listening");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const port = (server.address() as AddressInfo).port;

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        const grace = setTimeout(() => {
          if ("closeAllConnections" in server) server.closeAllConnections();
        }, CLOSE_GRACE_MS);
        grace.unref();
        try {
          await new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
            if ("closeIdleConnections" in server) server.closeIdleConnections();
          });
        } finally {
          clearTimeout(grace);
        }
        await teardown();
        logger.info("api stopped");
      })());
    return { port, close };
  } catch (err) {
    await teardown();
    throw err;
  }
}
