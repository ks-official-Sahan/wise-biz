import { serve } from "@hono/node-server";
import { createPool, instrumentPool } from "@wise-biz/db";
import {
  assertProductionEnv,
  databaseEnv,
  defineEnv,
  httpEnv,
  observabilityEnv,
  redisEnv,
} from "@wise-biz/env";
import { createClient } from "redis";

import { createApp } from "./app.ts";
import { redisIdempotencyCache } from "./idempotency-cache.ts";
import { createLogger } from "./logger.ts";
import { modules } from "./modules.ts";

import type { EnvSource } from "@wise-biz/env";
import type { AddressInfo } from "node:net";

const CLOSE_GRACE_MS = 5000;

export const API_ENV = { ...databaseEnv, ...redisEnv, ...observabilityEnv, ...httpEnv };

export interface RunningServer {
  port: number;
  /** Stop accepting connections, drain, close pool and redis. */
  close(): Promise<void>;
}

/** Validate env, build dependencies, listen. `source` is a parameter so tests never touch process.env. */
export async function startServer(source: EnvSource = process.env): Promise<RunningServer> {
  assertProductionEnv(source);
  const env = defineEnv(API_ENV, source);
  const logger = createLogger(env.LOG_LEVEL);

  const pool = createPool(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    applicationName: "wb-api",
  });
  if (env.NODE_ENV !== "production") instrumentPool(pool);
  // Fail fast instead of retrying forever silently: readiness reports Redis, the API still serves.
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
      await redis.close();
    } catch {
      redis.destroy();
    }
  };

  try {
    // Not awaited: with an unreachable Redis connect() never settles. The client keeps reconnecting in the background.
    redis.connect().catch((err: unknown) => {
      logger.error({ err }, "redis connect failed");
    });

    const app = createApp({
      modules,
      pool,
      redis,
      env,
      logger,
      idempotencyCache: redisIdempotencyCache(redis, logger),
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
