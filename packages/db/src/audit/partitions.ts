import type pg from "pg";

/**
 * Create the current + next `monthsAhead` (default 3) monthly audit_log partitions (idempotent; UTC months).
 * Calls the SECURITY DEFINER SQL function; run it from the chainer role on a schedule. Returns partitions created.
 */
export async function ensureAuditPartitions(
  pool: Pick<pg.Pool, "query">,
  monthsAhead = 3,
): Promise<number> {
  if (!Number.isInteger(monthsAhead) || monthsAhead < 0 || monthsAhead > 24)
    throw new Error("monthsAhead must be an integer between 0 and 24");
  const res = await pool.query<{ n: number }>("select audit.ensure_partitions($1) as n", [
    monthsAhead,
  ]);
  return res.rows[0]?.n ?? 0;
}

/**
 * Consecutive full future months (from next month) that already have an audit_log partition. Export as a gauge; alert
 * when it falls below the partition job's `monthsAhead` minus slack. Takes a wb_chainer pool.
 */
export async function auditPartitionHorizon(pool: Pick<pg.Pool, "query">): Promise<number> {
  const res = await pool.query<{ n: number }>("select audit.partition_horizon_months() as n");
  return res.rows[0]?.n ?? 0;
}
