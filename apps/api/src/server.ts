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
import { createLogger } from "./logger.ts";
import { modules } from "./modules.ts";

import type { EnvSource } from "@wise-biz/env";
import type { AddressInfo } from "node:net";

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
  const redis = createClient({ url: env.REDIS_URL });
  redis.on("error", (err: unknown) => {
    logger.error({ err }, "redis error");
  });
  await redis.connect();

  const app = createApp({ modules, pool, redis, env, logger });
  const server = serve({ fetch: app.fetch, port: env.PORT }, (info: AddressInfo) => {
    logger.info({ port: info.port }, "api listening");
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        if ("closeIdleConnections" in server) server.closeIdleConnections();
      });
      await Promise.allSettled([pool.end(), redis.close()]);
      logger.info("api stopped");
    })());
  return { port, close };
}
