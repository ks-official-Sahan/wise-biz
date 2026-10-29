import {
  auditPartitionHorizon,
  createPool,
  instrumentPool,
  pruneIdempotencyKeys,
} from "@wise-biz/db";
import {
  assertProductionEnv,
  chainerEnv,
  storageEnv,
  consoleEnv,
  defineEnv,
  inviteEnv,
  mailEnv,
  observabilityEnv,
  workerEnv,
} from "@wise-biz/env";
import { createPgBus } from "@wise-biz/events";
import { createMailer } from "@wise-biz/mailer";
import {
  createAnchorJob,
  createAuditChainer,
  createPartitionJob,
  createPeriodic,
} from "@wise-biz/module-audit";
import { storeFromEnv } from "@wise-biz/storage";

import { createConsumers } from "./consumers.ts";
import { createLogger } from "./logger.ts";
import { OLDEST_UNCHAINED_SQL, createMetrics } from "./metrics.ts";
import { createRelay } from "./relay.ts";
import { settleSteps } from "./shutdown.ts";

import type { EnvSource } from "@wise-biz/env";
import type { ConsumerDefinition, OnMetric } from "@wise-biz/events";
import type { AuditOnMetric } from "@wise-biz/module-audit";
import type { Logger } from "pino";

export const WORKER_ENV = { ...observabilityEnv, ...workerEnv, ...chainerEnv };
/** Only the default consumer set needs these (invite email); an explicit consumer list does not require them. */
export const CONSUMER_ENV = { ...mailEnv, ...inviteEnv, ...consoleEnv, ...storageEnv };
const POOL_MAX = 10;
const CHAINER_POOL_MAX = 4;
const HOUR_MS = 3_600_000;
const PRUNE_BATCH = 1000;

export interface RunningWorker {
  logger: Logger;
  /** Finish the in-flight batch, stop the bus, close the pool. */
  stop(): Promise<void>;
}

/** Validate env, wire pool -> pg bus -> relay, start the loop. `source` is a parameter for tests. */
export function startWorker(
  source: EnvSource = process.env,
  consumers?: readonly ConsumerDefinition[],
  onMetricOverride?: OnMetric,
  onAuditMetricOverride?: AuditOnMetric,
): RunningWorker {
  assertProductionEnv(source);
  const env = defineEnv(WORKER_ENV, source);
  const logger = createLogger(env.LOG_LEVEL);
  const consumerEnv = consumers === undefined ? defineEnv(CONSUMER_ENV, source) : undefined;
  const poolError = (name: string) => (err: Error) => {
    logger.warn({ err, pool: name }, "idle postgres client error");
  };
  const pool = createPool(env.DATABASE_WORKER_URL, {
    max: POOL_MAX,
    applicationName: "wb-workers",
    onError: poolError("worker"),
  });
  if (env.NODE_ENV !== "production") instrumentPool(pool);
  const consumerSet =
    consumers ??
    createConsumers({
      mailer: createMailer(consumerEnv ?? defineEnv(CONSUMER_ENV, source)),
      consoleUrl: consumerEnv?.CONSOLE_URL ?? "",
      inviteSecret: consumerEnv?.INVITE_SECRET ?? "",
      imports: {
        pool,
        store: storeFromEnv(consumerEnv ?? defineEnv(CONSUMER_ENV, source)),
        onError: (err, importId) => {
          logger.error({ err, importId }, "catalog import job failed; POST /start resumes it");
        },
      },
    });
  // Audit: separate least-privilege pool (wb_chainer), never shared with the relay pool.
  const chainerPool = createPool(env.DATABASE_CHAINER_URL, {
    max: CHAINER_POOL_MAX,
    applicationName: "wb-audit-chainer",
    onError: poolError("chainer"),
  });
  // Real sink by default (tests may override): counters/gauges flushed as a structured log line every 60 s.
  const metrics = createMetrics({
    logger,
    oldestUnchainedAgeMs: async () => {
      const r = await chainerPool.query<{ age_ms: string | null }>(OLDEST_UNCHAINED_SQL);
      const v = r.rows[0]?.age_ms;
      return v === null || v === undefined ? null : Number(v);
    },
    partitionHorizonMonths: () => auditPartitionHorizon(chainerPool),
  });
  const onMetric = onMetricOverride ?? metrics.onMetric;
  const onAuditMetric = onAuditMetricOverride ?? metrics.onAuditMetric;
  const bus = createPgBus({
    pool,
    logger,
    onMetric,
    handlerTimeoutMs: env.WORKER_HANDLER_TIMEOUT_MS,
  });
  for (const c of consumerSet) bus.subscribe(c);
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
  metrics.start();
  logger.info({ consumers: consumerSet.map((c) => c.name) }, "worker started");
  return {
    logger,
    stop: async () => {
      // Every step runs even if an earlier one failed; the bus and both pools are ALWAYS closed.
      const failed = [
        ...(await settleSteps(
          [
            { name: "relay", run: () => relay.stop() },
            ...loops.map((l, i) => ({ name: `loop-${String(i)}`, run: () => l.stop() })),
          ],
          logger,
        )),
        ...(await settleSteps([{ name: "metrics", run: () => metrics.stop() }], logger)),
        ...(await settleSteps([{ name: "bus", run: () => bus.stop() }], logger)),
        ...(await settleSteps(
          [
            { name: "pool", run: () => pool.end() },
            { name: "chainer-pool", run: () => chainerPool.end() },
          ],
          logger,
        )),
      ];
      logger.info({ failed }, "worker stopped");
      if (failed.length > 0) throw new Error(`worker stop failed: ${failed.join(", ")}`);
    },
  };
}
