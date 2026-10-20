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
    return [
      e.id,
      e.topic,
      e.key,
      e.type,
      e.version,
      json(e.payload, "payload", e.id),
      json(e.headers ?? {}, "headers", e.id),
    ];
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
