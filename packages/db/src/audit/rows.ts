/**
 * Shared by the chainer and the verifier so the hash payload is rebuilt IDENTICALLY.
 * Payload (see modules/audit/migrations/0001_audit.sql): immutable columns only, nulls explicit, `at` rendered by
 * Postgres as UTC ISO-8601 with microseconds (a JS Date would truncate to milliseconds), ip via host() (no mask).
 * NOTE: columns are cast to text under their own names, so queries MUST `order by audit_log.<col>` (an unqualified
 * ORDER BY would sort the text output column, not the numeric one).
 */
export const PAYLOAD_COLUMNS = `id::text AS id, public_id::text AS public_id, tenant_id::text AS tenant_id,
  actor_type, actor_id, action, entity, entity_id, before, after, reason, host(ip) AS ip, device_id::text AS device_id,
  request_id, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;

export interface PayloadRow {
  id: string;
  public_id: string;
  tenant_id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  device_id: string | null;
  request_id: string;
  at: string;
}

export function auditPayload(r: PayloadRow): Record<string, unknown> {
  return {
    id: r.id,
    publicId: r.public_id,
    tenantId: r.tenant_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    before: r.before ?? null,
    after: r.after ?? null,
    reason: r.reason,
    ip: r.ip,
    deviceId: r.device_id,
    requestId: r.request_id,
    at: r.at,
  };
}
