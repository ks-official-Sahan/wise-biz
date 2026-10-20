import { isUuidV7 } from "../tx.ts";

import type { TxHandle } from "../tx.ts";

export type OutboxEvent = Readonly<{
  id: string;
  topic: string;
  key: string;
  type: string;
  version: number;
  payload: unknown;
  headers?: Readonly<Record<string, string>>;
}>;

const CHUNK = 500;
const MAX_PAYLOAD = 256 * 1024;
const MAX_HEADERS = 8 * 1024;
const HEADER_KEY = /^[a-z0-9-]{1,64}$/;
const RESERVED_HEADERS = new Set(["tenant-id", "event-id"]);
const COLS = 7;

function json(value: unknown, what: string, id: string): string {
  let s: unknown; // JSON.stringify(undefined|function|symbol) returns undefined despite its typing
  try {
    s = JSON.stringify(value);
  } catch (e) {
    throw new Error(`appendOutbox: ${what} of event ${id} is not JSON-serializable`, { cause: e });
  }
  if (typeof s !== "string") throw new Error(`appendOutbox: ${what} of event ${id} is not JSON`);
  return s;
}

/**
 * Append events to infra.outbox in the caller's transaction (same commit as the domain write).
 * tenant_id comes from the transaction's `app.tenant_id` (set by withTenantTx); a missing tenant fails the
 * NOT NULL / RLS check. One parameterised multi-row INSERT per 500 events; no-op for none.
 */
export async function appendOutbox(tx: TxHandle, events: readonly OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  const rows = events.map((e) => {
    if (!isUuidV7(e.id)) throw new Error(`appendOutbox: event id ${e.id} is not a UUIDv7`);
    if (!Number.isInteger(e.version) || e.version < 1)
      throw new Error(`appendOutbox: event ${e.id} version must be an integer >= 1`);
    if (e.topic.length > 200 || e.type.length > 200 || e.key.length > 500)
      throw new TypeError(`appendOutbox: event ${e.id} topic/type (<=200) or key (<=500) too long`);
    const payload = json(e.payload, "payload", e.id);
    const headers = json(e.headers ?? {}, "headers", e.id);
    if (Buffer.byteLength(payload) > MAX_PAYLOAD)
      throw new TypeError(`appendOutbox: payload of event ${e.id} exceeds 256 KiB`);
    if (Buffer.byteLength(headers) > MAX_HEADERS)
      throw new TypeError(`appendOutbox: headers of event ${e.id} exceed 8 KiB`);
    for (const k of Object.keys(e.headers ?? {})) {
      if (!HEADER_KEY.test(k) || RESERVED_HEADERS.has(k))
        throw new TypeError(
          `appendOutbox: event ${e.id} header name "${k}" is invalid or reserved`,
        );
    }
    return [e.id, e.topic, e.key, e.type, e.version, payload, headers];
  });
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk
      .map((_, r) => {
        const b = r * COLS;
        return `(nullif(current_setting('app.tenant_id', true), '')::uuid, $${String(b + 1)}, $${String(b + 2)}, $${String(b + 3)}, $${String(b + 4)}, $${String(b + 5)}, $${String(b + 6)}::jsonb, $${String(b + 7)}::jsonb)`;
      })
      .join(", ");
    await tx.query(
      `insert into infra.outbox (tenant_id, id, topic, key, type, version, payload, headers) values ${values}`,
      chunk.flat(),
    );
  }
}
