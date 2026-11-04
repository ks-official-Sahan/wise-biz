import {
  assertProductionEnv,
  defineEnv,
  observabilityEnv,
  realtimeEnv,
  redisEnv,
} from "@wise-biz/env";
import { createClient } from "redis";

import { createLogger } from "./logger.ts";
import { createRealtimeServer } from "./server.ts";

import type { Subscriber } from "./hub.ts";
import type { EnvSource } from "@wise-biz/env";
import type { Logger } from "pino";

export const REALTIME_ENV = { ...observabilityEnv, ...redisEnv, ...realtimeEnv };
const STATS_EVERY_MS = 60_000;

export interface RunningRealtime {
  logger: Logger;
  /** Port actually bound (differs from REALTIME_PORT when that is 0). */
  port: number;
  stop: () => Promise<void>;
}

/** Validate env, connect the Redis subscriber, listen. `source` is a parameter so tests never touch process.env. */
export async function startRealtime(source: EnvSource = process.env): Promise<RunningRealtime> {
  assertProductionEnv(source);
  const env = defineEnv(REALTIME_ENV, source);
  const logger = createLogger(env.LOG_LEVEL);
  const secret = env.REALTIME_TICKET_SECRET;
  if (secret === undefined) throw new Error("REALTIME_TICKET_SECRET is required for apps/realtime");

  const redis = createClient({
    url: env.REDIS_URL,
    socket: { connectTimeout: 2000, reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
  });
  redis.on("error", (err: unknown) => {
    logger.warn({ err }, "redis error");
  });
  await redis.connect();
  // node-redis restores pattern subscriptions after a reconnect by itself.
  const subscriber: Subscriber = {
    subscribe: (pattern, onMessage) =>
      redis.pSubscribe(pattern, (message, channel) => {
        onMessage(channel, message);
      }),
    unsubscribe: (pattern) => redis.pUnsubscribe(pattern),
  };
  const rt = createRealtimeServer({
    secret,
    subscriber,
    logger,
    maxConnections: env.REALTIME_MAX_CONNECTIONS,
    ready: () => redis.isReady,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      rt.server.once("error", reject);
      rt.server.listen(env.REALTIME_PORT, resolve);
    });
  } catch (err) {
    await rt.stop();
    await redis.close();
    throw err;
  }
  const address = rt.server.address();
  const port = typeof address === "object" && address !== null ? address.port : env.REALTIME_PORT;
  const stats = setInterval(() => {
    logger.info(rt.hub.snapshot(), "realtime stats");
  }, STATS_EVERY_MS);
  stats.unref();
  logger.info({ port }, "realtime started");
  return {
    logger,
    port,
    stop: async () => {
      clearInterval(stats);
      await rt.stop();
      if (redis.isOpen) await redis.close();
      logger.info("realtime stopped");
    },
  };
}
