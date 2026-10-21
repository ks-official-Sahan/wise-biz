import type { TxHandle } from "../tx.ts";
import type pg from "pg";

export type StoredResponse = Readonly<{
  status: number;
  /** Exact serialized response body; replayed byte-for-byte. */
  bodyText: string;
  headers: Readonly<Record<string, string>>;
}>;

export type IdempotencyLock =
  { state: "new" } | { state: "replay"; response: StoredResponse } | { state: "mismatch" };

function assertKey(key: string, requestHash: string): void {
  if (key.length < 8 || key.length > 255)
    throw new TypeError("idempotency key must be 8-255 chars");
  if (requestHash === "" || requestHash.length > 128)
    throw new TypeError("requestHash must be 1-128 chars");
}

/**
 * First call inside the mutation transaction. Takes a transaction-scoped advisory lock on (tenant, key) so a concurrent
 * duplicate waits here until the first transaction commits (then sees its row -> "replay") or rolls back (then runs as
 * "new"). Expired rows count as absent. "new" -> run the mutation and call saveIdempotencyResponse in the same tx.
 */
export async function lockIdempotencyKey(
  tx: TxHandle,
  input: { key: string; requestHash: string },
): Promise<IdempotencyLock> {
  assertKey(input.key, input.requestHash);
  const lock = await tx.query<{ has_tenant: boolean }>(
    `select nullif(current_setting('app.tenant_id', true), '') is not null as has_tenant,
            pg_advisory_xact_lock(hashtextextended(coalesce(current_setting('app.tenant_id', true), '') || ':' || $1, 0))`,
    [input.key],
  );
  if (lock.rows[0]?.has_tenant !== true)
    throw new Error("lockIdempotencyKey: no tenant in transaction");
  const res = await tx.query<{
    request_hash: string;
    response_status: number;
    response_body: string;
    response_headers: Record<string, string>;
  }>(
    `select request_hash, response_status, response_body, response_headers from infra.idempotency_keys
     where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and key = $1 and expires_at > now()`,
    [input.key],
  );
  const row = res.rows[0];
  if (row === undefined) return { state: "new" };
  if (row.request_hash !== input.requestHash) return { state: "mismatch" };
  return {
    state: "replay",
    response: {
      status: row.response_status,
      bodyText: row.response_body,
      headers: row.response_headers,
    },
  };
}

/**
 * Store the response in the mutation's transaction (rolls back with it). An existing EXPIRED row for the key is
 * replaced; a live row means the caller skipped lockIdempotencyKey and this throws.
 */
export async function saveIdempotencyResponse(
  tx: TxHandle,
  input: { key: string; requestHash: string; response: StoredResponse; ttlMs: number },
): Promise<void> {
  assertKey(input.key, input.requestHash);
  const { response, ttlMs } = input;
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("ttlMs must be an integer >= 1");
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599)
    throw new Error("response.status must be an HTTP status");
  const body = response.bodyText;
  if (typeof body !== "string")
    throw new Error("saveIdempotencyResponse: bodyText must be a string");
  const res = await tx.query(
    `insert into infra.idempotency_keys (tenant_id, key, request_hash, status, response_status, response_body, response_headers, expires_at)
     values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2, 'completed', $3, $4, $5::jsonb,
             now() + ($6::bigint * interval '1 millisecond'))
     on conflict (tenant_id, key) do update set
       request_hash = excluded.request_hash, status = excluded.status, response_status = excluded.response_status,
       response_body = excluded.response_body, response_headers = excluded.response_headers,
       created_at = now(), expires_at = excluded.expires_at
     where infra.idempotency_keys.expires_at <= now()`,
    [
      input.key,
      input.requestHash,
      response.status,
      body,
      JSON.stringify(response.headers),
      String(ttlMs),
    ],
  );
  if (res.rowCount !== 1)
    throw new Error("saveIdempotencyResponse: key already stored (lock first)");
}

/**
 * Prune up to `batch` expired keys across tenants (wb_worker pool). Returns the number removed; loop until < batch.
 * No row locks: FOR UPDATE would need UPDATE privilege, and concurrent pruners only wait on each other briefly.
 */
export async function pruneIdempotencyKeys(
  pool: Pick<pg.Pool, "query">,
  opts: { batch?: number } = {},
): Promise<number> {
  const batch = opts.batch ?? 1000;
  if (!Number.isInteger(batch) || batch < 1) throw new Error("batch must be an integer >= 1");
  const res = await pool.query(
    `delete from infra.idempotency_keys where expires_at <= now() and ctid = any(array(
         select ctid from infra.idempotency_keys where expires_at <= now() order by expires_at limit $1))`,
    [batch],
  );
  return res.rowCount ?? 0;
}
