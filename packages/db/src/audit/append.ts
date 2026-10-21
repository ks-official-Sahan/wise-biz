import type { TxHandle } from "../tx.ts";

export type AuditActorType = "user" | "device" | "system" | "mcp";

export type AuditEntry = Readonly<{
  actorType: AuditActorType;
  actorId: string;
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  deviceId?: string;
  requestId: string;
}>;

const ACTORS: ReadonlySet<string> = new Set(["user", "device", "system", "mcp"]);
const CHUNK = 500;
const COLS = 11;
const MAX_JSON = 64 * 1024;
const MAX_TEXT = 200;
const MAX_REASON = 1000;

function json(value: unknown, what: string, action: string): string | null {
  if (value === undefined || value === null) return null;
  let s: unknown; // JSON.stringify(function|symbol) returns undefined despite its typing
  try {
    s = JSON.stringify(value);
  } catch (e) {
    throw new Error(`appendAudit: ${what} of "${action}" is not JSON-serializable`, { cause: e });
  }
  if (typeof s !== "string") throw new Error(`appendAudit: ${what} of "${action}" is not JSON`);
  if (Buffer.byteLength(s) > MAX_JSON)
    throw new TypeError(`appendAudit: ${what} of "${action}" exceeds 64 KiB`);
  return s;
}

function text(
  value: string | undefined,
  what: string,
  max: number,
  required: boolean,
): string | null {
  if (value === undefined) {
    if (required) throw new TypeError(`appendAudit: ${what} is required`);
    return null;
  }
  if ((required && value.trim() === "") || value.length > max)
    throw new TypeError(
      `appendAudit: ${what} must be ${required ? "non-empty and " : ""}<= ${String(max)} chars`,
    );
  return value;
}

/**
 * Append audit rows to audit.audit_log in the caller's transaction (same commit as the domain write, so a rolled-back
 * mutation leaves no audit row). tenant_id comes from the transaction's `app.tenant_id` (set by withTenantTx); a missing
 * tenant fails NOT NULL / RLS. Rows are inserted UNCHAINED; the chainer fills chain_seq/prev_hash/hash later.
 * One parameterised multi-row INSERT per 500 entries; no-op for none.
 */
export async function appendAudit(tx: TxHandle, entries: readonly AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries.map((e) => {
    if (!ACTORS.has(e.actorType))
      throw new TypeError(`appendAudit: invalid actorType ${e.actorType}`);
    return [
      e.actorType,
      text(e.actorId, "actorId", MAX_TEXT, true),
      text(e.action, "action", MAX_TEXT, true),
      text(e.entity, "entity", MAX_TEXT, true),
      text(e.entityId, "entityId", MAX_TEXT, false),
      json(e.before, "before", e.action),
      json(e.after, "after", e.action),
      text(e.reason, "reason", MAX_REASON, false),
      e.ip ?? null,
      e.deviceId ?? null,
      text(e.requestId, "requestId", MAX_TEXT, true),
    ];
  });
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk
      .map((_, r) => {
        const b = r * COLS;
        const p = (n: number): string => `$${String(b + n)}`;
        return `(nullif(current_setting('app.tenant_id', true), '')::uuid, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}::jsonb, ${p(7)}::jsonb, ${p(8)}, ${p(9)}::inet, ${p(10)}::uuid, ${p(11)})`;
      })
      .join(", ");
    await tx.query(
      `insert into audit.audit_log (tenant_id, actor_type, actor_id, action, entity, entity_id, before, after, reason, ip, device_id, request_id) values ${values}`,
      chunk.flat(),
    );
  }
}
