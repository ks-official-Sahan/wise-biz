import type pg from "pg";

/** Worker-side helpers; run with a wb_worker connection inside a caller-managed transaction. */
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
}

/** Lock up to `limit` unpublished rows (all tenants, arrival order). Others' locked rows are skipped. */
export async function claimOutboxBatch(
  client: Client,
  opts: { limit?: number } = {},
): Promise<OutboxRow[]> {
  const limit = opts.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("claimOutboxBatch: limit must be >= 1");
  const res = await client.query<RawRow>(
    `select tenant_id, id, topic, key, type, version, payload, headers, created_at, attempts
       from infra.outbox
      where published_at is null
      order by created_at, id
      limit $1
      for update skip locked`,
    [limit],
  );
  return res.rows.map((r) => ({
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
  }));
}

const split = (keys: readonly OutboxKey[]): [string[], string[]] => [
  keys.map((k) => k.tenantId),
  keys.map((k) => k.id),
];

/** One UPDATE for the whole batch. Returns rows changed. */
export async function markPublished(client: Client, keys: readonly OutboxKey[]): Promise<number> {
  if (keys.length === 0) return 0;
  const res = await client.query(
    `update infra.outbox o set published_at = now()
       from unnest($1::uuid[], $2::uuid[]) as k(tenant_id, id)
      where o.tenant_id = k.tenant_id and o.id = k.id and o.published_at is null`,
    split(keys),
  );
  return res.rowCount ?? 0;
}

/** Count a failed publish attempt for the batch. Returns rows changed. */
export async function bumpAttempts(client: Client, keys: readonly OutboxKey[]): Promise<number> {
  if (keys.length === 0) return 0;
  const res = await client.query(
    `update infra.outbox o set attempts = o.attempts + 1
       from unnest($1::uuid[], $2::uuid[]) as k(tenant_id, id)
      where o.tenant_id = k.tenant_id and o.id = k.id and o.published_at is null`,
    split(keys),
  );
  return res.rowCount ?? 0;
}

/** Consumer idempotency: true the first time (consumer, eventId) is seen, false for a duplicate. */
export async function recordProcessed(
  client: Client,
  p: Readonly<{ tenantId: string; consumer: string; eventId: string }>,
): Promise<boolean> {
  const res = await client.query(
    `insert into infra.processed_events (tenant_id, consumer, event_id) values ($1, $2, $3)
     on conflict do nothing returning 1`,
    [p.tenantId, p.consumer, p.eventId],
  );
  return res.rowCount === 1;
}

const MAX_ERROR = 1000;

/** Park a failed event. Error is cut to its first line and 1000 chars (no stack traces). Returns false if already parked. */
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
  const error = (p.error.split("\n", 1)[0] ?? "").slice(0, MAX_ERROR) || "unknown error";
  const res = await client.query(
    `insert into infra.dead_letters (tenant_id, consumer, event_id, error, attempts, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb) on conflict (consumer, event_id) do nothing returning 1`,
    [p.tenantId, p.consumer, p.eventId, error, p.attempts, JSON.stringify(p.payload)],
  );
  return res.rowCount === 1;
}
