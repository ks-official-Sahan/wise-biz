import { buildDailyAnchor } from "@wise-biz/db";

import { createPeriodic } from "./loop.ts";
import { errorInfo, safely, systemClock } from "./types.ts";
import { verifyAuditChain } from "./verify.ts";

import type { Periodic } from "./loop.ts";
import type { AuditLogger, AuditMetricName, AuditOnMetric, Clock } from "./types.ts";
import type pg from "pg";

export type AnchorJobOptions = Readonly<{
  /** Pool connected as wb_chainer. */
  pool: pg.Pool;
  logger: AuditLogger;
  clock?: Clock;
  onMetric?: AuditOnMetric | undefined;
  /** How often to check whether yesterday's anchors are due (default 5 min). */
  pollMs?: number;
  /** Tenants per keyset page of chain_heads (default 500). */
  pageSize?: number;
  /** Minutes after 00:00 UTC before building (default 5). */
  delayMinutes?: number;
  /** Verify each freshly created anchor incrementally and alert loudly on failure (default true). */
  verify?: boolean;
}>;

export type AnchorRunResult = Readonly<{
  day: string | undefined;
  created: number;
  exists: number;
  pending: number;
  empty: number;
  failed: number;
  verifyFailed: number;
}>;

export interface AnchorJob extends Periodic {
  /** Build yesterday's anchors if due and not already done by this process. Idempotent. */
  runDue(): Promise<AnchorRunResult>;
}

const DAY_MS = 86_400_000;

/** UTC day (YYYY-MM-DD) before `nowMs`, or undefined before `delayMinutes` after midnight UTC. */
export function dueDay(nowMs: number, delayMinutes: number): string | undefined {
  const sinceMidnight = nowMs % DAY_MS;
  if (sinceMidnight < delayMinutes * 60_000) return undefined;
  return new Date(nowMs - sinceMidnight - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Daily anchor job: once per UTC day after 00:05 builds yesterday's Merkle anchor for every tenant with a
 * chain (chain_heads keyset scan, PK-ordered). buildDailyAnchor is idempotent, so a restart or a second worker
 * only re-reads. Tenants whose rows are still unchained report "pending" and are retried on the next poll.
 */
export function createAnchorJob(opts: AnchorJobOptions): AnchorJob {
  const { pool, logger, onMetric } = opts;
  const clock = opts.clock ?? systemClock;
  const pageSize = opts.pageSize ?? 500;
  const delay = opts.delayMinutes ?? 5;
  const verify = opts.verify ?? true;
  let doneDay: string | undefined;

  const metric = (name: AuditMetricName, value = 1, labels = {}): void => {
    safely(() => onMetric?.(name, value, labels));
  };

  async function runDue(): Promise<AnchorRunResult> {
    const day = dueDay(clock.now(), delay);
    const r = { created: 0, exists: 0, pending: 0, empty: 0, failed: 0, verifyFailed: 0 };
    if (day === undefined || day === doneDay) return { day: undefined, ...r };
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const page = await pool.query<{ tenant_id: string }>(
        "select tenant_id::text from audit.chain_heads where tenant_id > $1 order by tenant_id limit $2",
        [after, pageSize],
      );
      for (const { tenant_id: tenantId } of page.rows) {
        try {
          const res = await buildDailyAnchor(pool, tenantId, day);
          if (res.status === "created") {
            r.created += 1;
            metric("audit_anchor_created", 1, { tenantId });
          } else r[res.status] += 1;
          if (verify && res.status === "created") {
            const v = await verifyAuditChain(pool, tenantId, { incremental: true });
            if (!v.ok) {
              r.verifyFailed += 1;
              metric("audit_verify_failed", 1, { tenantId });
              safely(() => {
                logger.error(
                  { tenantId, day, reason: v.reason, chainSeq: v.chainSeq },
                  "AUDIT CHAIN VERIFICATION FAILED",
                );
              });
            }
          }
        } catch (e) {
          r.failed += 1;
          metric("audit_anchor_error", 1, { tenantId });
          safely(() => {
            logger.error({ tenantId, day, err: errorInfo(e) }, "audit anchor failed");
          });
        }
      }
      const last = page.rows[page.rows.length - 1];
      if (last === undefined || page.rows.length < pageSize) break;
      after = last.tenant_id;
    }
    if (r.failed === 0 && r.pending === 0) doneDay = day;
    return { day, ...r };
  }

  const periodic = createPeriodic({
    name: "audit-anchor",
    intervalMs: opts.pollMs ?? 300_000,
    logger,
    onMetric,
    run: async () => {
      await runDue();
    },
  });
  return { ...periodic, runDue };
}
