import type pg from "pg";

/** Relay helpers take a wb_worker POOL and run their own short statements; consumer helpers take a CLIENT in the consumer's tx. */
type Pool = Pick<pg.Pool, "query">;
type Client = Pick<pg.ClientBase, "query">;

export type OutboxKey = Readonly<{ tenantId: string; id: string }>;

export type OutboxRow = Readonly<{
  tenantId: string;
  id: string;
  topic: string;
  key: string;
  type: string;
  version: number;
  payload: unknown;
  headers: Record<string, string>;
  createdAt: Date;
  attempts: number;
  claimedUntil: Date | null;
  claimedBy: string | null;
}>;

interface RawRow {
  tenant_id: string;
  id: string;
  topic: string;
  key: string;
  type: string;
  version: number;
  payload: unknown;
  headers: Record<string, string>;
  created_at: Date;
  attempts: number;
  claimed_until: Date | null;
  claimed_by: string | null;
}

const posInt = (n: number, what: string): void => {
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be an integer >= 1`);
};

/**
 * Lease up to `limit` ready rows in ONE auto-commit statement (all tenants, arrival order). Each claim bumps
 * attempts and sets claimed_until/claimed_by; rows locked by another claimer are skipped, rows whose lease is
 * still live are excluded, rows at maxAttempts or quarantined are never returned.
 */
export async function claimOutboxBatch(
  pool: Pool,
  opts: { limit?: number; leaseMs?: number; maxAttempts?: number; workerId: string },
): Promise<OutboxRow[]> {
  const { limit = 500, leaseMs = 300_000, maxAttempts = 10, workerId } = opts;
  posInt(limit, "claimOutboxBatch: limit");
  posInt(leaseMs, "claimOutboxBatch: leaseMs");
  posInt(maxAttempts, "claimOutboxBatch: maxAttempts");
  if (workerId === "") throw new Error("claimOutboxBatch: workerId required");
  const res = await pool.query<RawRow>(
    `update infra.outbox o
        set claimed_until = now() + make_interval(secs => $1::float8 / 1000.0),
            claimed_by = $2,
            attempts = o.attempts + 1
       from (select tenant_id, id from infra.outbox
              where published_at is null and quarantined_at is null and attempts < $3
                and (claimed_until is null or claimed_until < now())
              order by created_at, id
              limit $4
                for update skip locked) c
      where o.tenant_id = c.tenant_id and o.id = c.id
  returning o.*`,
    [leaseMs, workerId, maxAttempts, limit],
  );
  return res.rows
    .map((r) => ({
      tenantId: r.tenant_id,
      id: r.id,
      topic: r.topic,
      key: r.key,
      type: r.type,
      version: r.version,
      payload: r.payload,
      headers: r.headers,
      createdAt: r.created_at,
      attempts: r.attempts,
      claimedUntil: r.claimed_until,
      claimedBy: r.claimed_by,
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

const split = (keys: readonly OutboxKey[]): [string[], string[]] => [
  keys.map((k) => k.tenantId),
  keys.map((k) => k.id),
];

/** Mark rows published, only those still claimed by `workerId`. Returns rows changed. */
export async function markPublished(
  pool: Pool,
  keys: readonly OutboxKey[],
  workerId: string,
): Promise<number> {
  if (keys.length === 0) return 0;
  const res = await pool.query(
    `update infra.outbox o set published_at = now(), claimed_until = null
       from unnest($1::uuid[], $2::uuid[]) as k(tenant_id, id)
      where o.tenant_id = k.tenant_id and o.id = k.id
        and o.published_at is null and o.claimed_by = $3`,
    [...split(keys), workerId],
  );
  return res.rowCount ?? 0;
}

/** Drop this worker's lease so the rows are retried at once (after a publish failure). Returns rows changed. */
export async function releaseClaims(
  pool: Pool,
  keys: readonly OutboxKey[],
  workerId: string,
): Promise<number> {
  if (keys.length === 0) return 0;
  const res = await pool.query(
    `update infra.outbox o set claimed_until = null
       from unnest($1::uuid[], $2::uuid[]) as k(tenant_id, id)
      where o.tenant_id = k.tenant_id and o.id = k.id
        and o.published_at is null and o.claimed_by = $3`,
    [...split(keys), workerId],
  );
  return res.rowCount ?? 0;
}

/** Quarantine unpublished rows that used all attempts and whose lease expired. Returns their keys. */
export async function quarantineExhausted(
  pool: Pool,
  opts: { maxAttempts?: number } = {},
): Promise<OutboxKey[]> {
  const maxAttempts = opts.maxAttempts ?? 10;
  posInt(maxAttempts, "quarantineExhausted: maxAttempts");
  const res = await pool.query<{ tenant_id: string; id: string }>(
    `update infra.outbox set quarantined_at = now()
      where published_at is null and quarantined_at is null and attempts >= $1
        and (claimed_until is null or claimed_until < now())
  returning tenant_id, id`,
    [maxAttempts],
  );
  return res.rows.map((r) => ({ tenantId: r.tenant_id, id: r.id }));
}

const DAY = 86_400_000;

async function prune(
  pool: Pool,
  table: "outbox" | "processed_events",
  col: "published_at" | "processed_at",
  ageMs: number,
  batch: number,
): Promise<number> {
  posInt(ageMs, "prune: olderThanMs");
  posInt(batch, "prune: batch");
  let total = 0;
  for (;;) {
    const res = await pool.query(
      `delete from infra.${table} where ctid in (
         select ctid from infra.${table}
          where ${col} is not null and ${col} < now() - make_interval(secs => $1::float8 / 1000.0)
          order by ${col} limit $2)`,
      [ageMs, batch],
    );
    const n = res.rowCount ?? 0;
    total += n;
    if (n < batch) return total;
  }
}

/** Delete published rows older than the threshold, in batches. Returns rows deleted. */
export function pruneOutbox(
  pool: Pool,
  opts: { olderThanMs?: number; batch?: number } = {},
): Promise<number> {
  return prune(pool, "outbox", "published_at", opts.olderThanMs ?? 7 * DAY, opts.batch ?? 5000);
}

/** Delete processed_events older than the threshold, in batches. Returns rows deleted. */
export function pruneProcessedEvents(
  pool: Pool,
  opts: { olderThanMs?: number; batch?: number } = {},
): Promise<number> {
  return prune(
    pool,
    "processed_events",
    "processed_at",
    opts.olderThanMs ?? 30 * DAY,
    opts.batch ?? 5000,
  );
}

/** Consumer idempotency (call inside the consumer's tx): true the first time, false for a duplicate. */
export async function recordProcessed(
  client: Client,
  p: Readonly<{ tenantId: string; consumer: string; eventId: string }>,
): Promise<boolean> {
  const res = await client.query(
    `insert into infra.processed_events (tenant_id, consumer, event_id) values ($1, $2, $3)
     on conflict (consumer, tenant_id, event_id) do nothing returning 1`,
    [p.tenantId, p.consumer, p.eventId],
  );
  return res.rowCount === 1;
}

const MAX_ERROR = 1000;

/**
 * Park a failed event (call inside the consumer's tx). Error: control chars (incl. NUL) stripped except \n\t,
 * first line only, <= 1000 chars. Re-parking updates attempts/error/failed_at. True when newly inserted.
 */
export async function recordDeadLetter(
  client: Client,
  p: Readonly<{
    tenantId: string;
    consumer: string;
    eventId: string;
    error: string;
    attempts: number;
    payload: unknown;
  }>,
): Promise<boolean> {
  // eslint-disable-next-line no-control-regex -- stripping NUL/control chars is the point
  const clean = p.error.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  const error = (clean.split("\n", 1)[0] ?? "").slice(0, MAX_ERROR) || "unknown error";
  const res = await client.query<{ inserted: boolean }>(
    `insert into infra.dead_letters (tenant_id, consumer, event_id, error, attempts, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (consumer, tenant_id, event_id) do update
       set attempts = excluded.attempts, error = excluded.error, failed_at = now()
     returning (xmax = 0) as inserted`,
    [p.tenantId, p.consumer, p.eventId, error, p.attempts, JSON.stringify(p.payload)],
  );
  return res.rows[0]?.inserted === true;
}
