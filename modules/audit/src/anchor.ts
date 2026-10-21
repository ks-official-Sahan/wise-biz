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
  /** Verify each tenant incrementally after its anchors are created or found, alert loudly on failure (default true). */
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
/** Longest gap backfilled after downtime (days before yesterday). */
const MAX_BACKFILL_DAYS = 30;
/** A day still "pending" this long after it ended means the chainer is stuck: page someone. */
const PENDING_ALERT_MS = 6 * 3_600_000;

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

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
  const alerted = new Set<string>();

  const metric = (name: AuditMetricName, value = 1, labels = {}): void => {
    safely(() => onMetric?.(name, value, labels));
  };

  async function runDue(): Promise<AnchorRunResult> {
    const day = dueDay(clock.now(), delay);
    const r = { created: 0, exists: 0, pending: 0, empty: 0, failed: 0, verifyFailed: 0 };
    if (day === undefined || day === doneDay) return { day: undefined, ...r };
    const yesterdayMs = dayMs(day);
    const floorMs = yesterdayMs - MAX_BACKFILL_DAYS * DAY_MS;
    const alertedNow = new Set<string>();
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      // PK probes: chain_heads keyset + anchors (tenant_id, day) max.
      const page = await pool.query<{ tenant_id: string; last_day: string | null }>(
        `select h.tenant_id::text, (select max(a.day)::text from audit.anchors a where a.tenant_id = h.tenant_id) last_day
           from audit.chain_heads h where h.tenant_id > $1 order by h.tenant_id limit $2`,
        [after, pageSize],
      );
      for (const { tenant_id: tenantId, last_day: lastDay } of page.rows) {
        try {
          // From the last anchored day (re-read + re-verified) up to yesterday, at most 31 days back.
          const startMs = lastDay === null ? yesterdayMs : Math.max(floorMs, dayMs(lastDay));
          let needsVerify = false;
          for (let d = startMs; d <= yesterdayMs; d += DAY_MS) {
            const dayStr = new Date(d).toISOString().slice(0, 10);
            const res = await buildDailyAnchor(pool, tenantId, dayStr);
            if (res.status === "created") {
              r.created += 1;
              metric("audit_anchor_created", 1, { tenantId });
            } else r[res.status] += 1;
            if (res.status === "created" || res.status === "exists") needsVerify = true;
            if (res.status === "pending") {
              metric("audit_anchor_pending", 1, { tenantId });
              const key = `${tenantId}:${dayStr}`;
              if (d + DAY_MS + PENDING_ALERT_MS < clock.now() && !alerted.has(key)) {
                alerted.add(key);
                alertedNow.add(key);
                safely(() => {
                  logger.error(
                    { tenantId, day: dayStr },
                    "AUDIT ANCHOR PENDING > 6h: chainer is not keeping up",
                  );
                });
              } else if (alerted.has(key)) alertedNow.add(key);
            }
          }
          if (verify && needsVerify) {
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
    // Forget alerts that resolved so the set stays bounded and a recurrence alerts again.
    for (const k of alerted) if (!alertedNow.has(k)) alerted.delete(k);
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
