import { createPool, instrumentPool, pruneIdempotencyKeys } from "@wise-biz/db";
import {
  assertProductionEnv,
  chainerEnv,
  defineEnv,
  observabilityEnv,
  workerEnv,
} from "@wise-biz/env";
import { createPgBus } from "@wise-biz/events";
import {
  createAnchorJob,
  createAuditChainer,
  createPartitionJob,
  createPeriodic,
} from "@wise-biz/module-audit";

import { consumers as defaultConsumers } from "./consumers.ts";
import { createLogger } from "./logger.ts";
import { createRelay } from "./relay.ts";

import type { EnvSource } from "@wise-biz/env";
import type { ConsumerDefinition, OnMetric } from "@wise-biz/events";
import type { AuditOnMetric } from "@wise-biz/module-audit";

export const WORKER_ENV = { ...observabilityEnv, ...workerEnv, ...chainerEnv };
const POOL_MAX = 10;
const CHAINER_POOL_MAX = 4;
const HOUR_MS = 3_600_000;
const PRUNE_BATCH = 1000;

export interface RunningWorker {
  /** Finish the in-flight batch, stop the bus, close the pool. */
  stop(): Promise<void>;
}

/** Validate env, wire pool -> pg bus -> relay, start the loop. `source` is a parameter for tests. */
export function startWorker(
  source: EnvSource = process.env,
  consumers: readonly ConsumerDefinition[] = defaultConsumers,
  onMetric?: OnMetric,
  onAuditMetric?: AuditOnMetric,
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

  // Audit: separate least-privilege pool (wb_chainer), never shared with the relay pool.
  const chainerPool = createPool(env.DATABASE_CHAINER_URL, {
    max: CHAINER_POOL_MAX,
    applicationName: "wb-audit-chainer",
  });
  const chainer = createAuditChainer({
    pool: chainerPool,
    logger,
    intervalMs: env.AUDIT_CHAIN_INTERVAL_MS,
    onMetric: onAuditMetric,
  });
  const anchorJob = createAnchorJob({ pool: chainerPool, logger, onMetric: onAuditMetric });
  const partitionJob = createPartitionJob({ pool: chainerPool, logger, onMetric: onAuditMetric });
  const pruneJob = createPeriodic({
    name: "idempotency-prune",
    intervalMs: HOUR_MS,
    logger,
    onMetric: onAuditMetric,
    run: async () => {
      let n: number;
      do {
        n = await pruneIdempotencyKeys(pool, { batch: PRUNE_BATCH });
      } while (n >= PRUNE_BATCH);
    },
  });
  const loops = [chainer, anchorJob, partitionJob, pruneJob];
  for (const l of loops) l.start();
  logger.info({ consumers: consumers.map((c) => c.name) }, "worker started");
  return {
    stop: async () => {
      await Promise.all([relay.stop(), ...loops.map((l) => l.stop())]);
      await bus.stop();
      await Promise.all([pool.end(), chainerPool.end()]);
      logger.info({}, "worker stopped");
    },
  };
}
