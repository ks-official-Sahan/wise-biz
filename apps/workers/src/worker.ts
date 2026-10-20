import { createPool, instrumentPool } from "@wise-biz/db";
import { assertProductionEnv, defineEnv, observabilityEnv, workerEnv } from "@wise-biz/env";
import { createPgBus } from "@wise-biz/events";

import { consumers as defaultConsumers } from "./consumers.ts";
import { createLogger } from "./logger.ts";
import { createRelay } from "./relay.ts";

import type { EnvSource } from "@wise-biz/env";
import type { ConsumerDefinition, OnMetric } from "@wise-biz/events";

export const WORKER_ENV = { ...observabilityEnv, ...workerEnv };
const POOL_MAX = 10;

export interface RunningWorker {
  /** Finish the in-flight batch, stop the bus, close the pool. */
  stop(): Promise<void>;
}

/** Validate env, wire pool -> pg bus -> relay, start the loop. `source` is a parameter for tests. */
export function startWorker(
  source: EnvSource = process.env,
  consumers: readonly ConsumerDefinition[] = defaultConsumers,
  onMetric?: OnMetric,
): RunningWorker {
  assertProductionEnv(source);
  const env = defineEnv(WORKER_ENV, source);
  const logger = createLogger(env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_WORKER_URL, {
    max: POOL_MAX,
    applicationName: "wb-workers",
  });
  if (env.NODE_ENV !== "production") instrumentPool(pool);
  const bus = createPgBus({
    pool,
    logger,
    onMetric,
    handlerTimeoutMs: env.WORKER_HANDLER_TIMEOUT_MS,
  });
  for (const c of consumers) bus.subscribe(c);
  const relay = createRelay({
    pool,
    bus,
    logger,
    batchSize: env.WORKER_RELAY_BATCH,
    idleMs: env.WORKER_IDLE_MS,
    leaseMs: env.WORKER_LEASE_MS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
    onMetric,
  });
  relay.start();
  logger.info({ consumers: consumers.map((c) => c.name) }, "worker started");
  return {
    stop: async () => {
      await relay.stop();
      await bus.stop();
      await pool.end();
      logger.info({}, "worker stopped");
    },
  };
}
