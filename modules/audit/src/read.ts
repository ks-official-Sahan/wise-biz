import type { TxHandle } from "@wise-biz/db";

/** Filters of the console audit viewer. All optional; tenant scope comes from the transaction (RLS). */
export interface AuditFilter {
  readonly actorId?: string | undefined;
  readonly action?: string | undefined;
  readonly entity?: string | undefined;
  readonly entityId?: string | undefined;
  /** Inclusive lower bound. */
  readonly from?: Date | undefined;
  /** Exclusive upper bound. */
  readonly to?: Date | undefined;
}

/** Keyset position: the last row of the previous page, ordered (at desc, id desc). */
export interface AuditCursor {
  /** `at` as Postgres text with microseconds; compared as timestamptz, so no precision is lost in transit. */
  readonly at: string;
  readonly id: string;
}

export interface AuditListRow {
  readonly publicId: string;
  readonly at: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly requestId: string;
  readonly cursor: AuditCursor;
}

export interface AuditDetailRow extends AuditListRow {
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly chained: boolean;
}

interface DbRow {
  public_id: string;
  at_iso: string;
  at_key: string;
  id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  request_id: string;
}

const LIST_COLS = `public_id,
  to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_iso,
  at::text as at_key, id::text as id,
  actor_type, actor_id, action, entity, entity_id, request_id`;

const toListRow = (r: DbRow): AuditListRow => ({
  publicId: r.public_id,
  at: r.at_iso,
  actorType: r.actor_type,
  actorId: r.actor_id,
  action: r.action,
  entity: r.entity,
  entityId: r.entity_id,
  requestId: r.request_id,
  cursor: { at: r.at_key, id: r.id },
});

/**
 * WHERE clause for the filters. Every value is a parameter; the clause text depends only on which filters are present,
 * so each combination is one cached plan. Indexes: actor -> audit_log_actor_idx, action -> audit_log_action_idx,
 * entity -> audit_log_entity_idx, none -> audit_log_pkey (tenant_id, at, id).
 */
function where(
  filter: AuditFilter,
  cursor: AuditCursor | undefined,
): { sql: string; params: unknown[] } {
  const parts = ["tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid"];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    params.push(value);
    parts.push(sql.replace("?", `$${String(params.length)}`));
  };
  if (filter.actorId !== undefined) add("actor_id = ?", filter.actorId);
  if (filter.action !== undefined) add("action = ?", filter.action);
  if (filter.entity !== undefined) add("entity = ?", filter.entity);
  if (filter.entityId !== undefined) add("entity_id = ?", filter.entityId);
  if (filter.from !== undefined) add("at >= ?", filter.from);
  if (filter.to !== undefined) add("at < ?", filter.to);
  if (cursor !== undefined) {
    params.push(cursor.at, cursor.id);
    parts.push(
      `(at, id) < ($${String(params.length - 1)}::timestamptz, $${String(params.length)}::bigint)`,
    );
  }
  return { sql: parts.join(" and "), params };
}

/** ONE query, newest first, `limit` rows. */
export async function listAuditEntries(
  tx: TxHandle,
  filter: AuditFilter,
  limit: number,
  cursor?: AuditCursor,
): Promise<AuditListRow[]> {
  const w = where(filter, cursor);
  const res = await tx.query<DbRow>(
    `select ${LIST_COLS} from audit.audit_log
     where ${w.sql}
     order by at desc, id desc
     limit $${String(w.params.length + 1)}`,
    [...w.params, limit],
  );
  return res.rows.map(toListRow);
}

/** ONE query by public id (no index of its own; bounded by the time embedded in the UUIDv7, see below). */
export async function findAuditEntry(
  tx: TxHandle,
  publicId: string,
): Promise<AuditDetailRow | null> {
  // public_id is a UUIDv7 minted at insert, so its timestamp bounds `at` closely: a +-1 day window lets partition
  // pruning and the PK cut the scan to one or two partitions instead of all of them.
  const res = await tx.query<
    DbRow & { before: unknown; after: unknown; reason: string | null; chained: boolean }
  >(
    `select ${LIST_COLS}, before, after, reason, hash is not null as chained
     from audit.audit_log
     where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
       and public_id = $1
       and at >= $2::timestamptz - interval '1 day' and at < $2::timestamptz + interval '1 day'`,
    [publicId, uuidV7Time(publicId)],
  );
  const r = res.rows[0];
  if (r === undefined) return null;
  return {
    ...toListRow(r),
    before: r.before,
    after: r.after,
    reason: r.reason,
    chained: r.chained,
  };
}

/** The millisecond timestamp embedded in a UUIDv7 (first 48 bits). */
export function uuidV7Time(id: string): Date {
  return new Date(Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16));
}
