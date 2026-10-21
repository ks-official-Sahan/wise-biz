import { ensureAuditPartitions } from "@wise-biz/db";

import { createPeriodic } from "./loop.ts";
import { safely } from "./types.ts";

import type { Periodic } from "./loop.ts";
import type { AuditLogger, AuditOnMetric } from "./types.ts";
import type pg from "pg";

export type PartitionJobOptions = Readonly<{
  /** Pool connected as wb_chainer (EXECUTE on the SECURITY DEFINER audit.ensure_partitions). */
  pool: pg.Pool;
  logger: AuditLogger;
  monthsAhead?: number;
  intervalMs?: number;
  onMetric?: AuditOnMetric | undefined;
}>;

/** Creates the current + next `monthsAhead` (default 3) monthly partitions at boot, then daily. Idempotent. */
export function createPartitionJob(opts: PartitionJobOptions): Periodic {
  const monthsAhead = opts.monthsAhead ?? 3;
  return createPeriodic({
    name: "audit-partitions",
    intervalMs: opts.intervalMs ?? 86_400_000,
    logger: opts.logger,
    onMetric: opts.onMetric,
    run: async () => {
      const n = await ensureAuditPartitions(opts.pool, monthsAhead);
      if (n > 0) {
        safely(() => {
          opts.onMetric?.("audit_partitions_created", n, {});
        });
        safely(() => {
          opts.logger.info({ created: n }, "audit partitions created");
        });
      }
    },
  });
}
