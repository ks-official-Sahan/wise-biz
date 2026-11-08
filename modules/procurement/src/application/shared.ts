import { DomainError } from "@wise-biz/errors";

import { PROCUREMENT_TOPIC } from "../events.ts";

import type { OutboxEvent } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function notFound(): never {
  throw new DomainError("NOT_FOUND", "Not found");
}

export function invalid(path: string, message: string): never {
  throw new DomainError("VALIDATION_FAILED", "invalid request", {
    fieldErrors: [{ path, message }],
  });
}

export const conflict = (message: string): DomainError => new DomainError("CONFLICT", message);

/** Optimistic concurrency: the editor must send the version it loaded. */
export function requireVersion(current: number, sent: number): void {
  if (current !== sent) {
    throw conflict("Someone else changed this. Reload and try again.");
  }
}

export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) return notFound();
  return row;
}

export const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** Keyset cursor: opaque base64url of the last id (UUIDv7, so id order is creation order). */
export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!UUID_RE.test(id)) invalid("after", "invalid cursor");
  return id;
}

/** Fetch limit + 1 rows; the extra row proves there is a next page without a count query. */
export function page<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const more = rows.length > limit && last !== undefined;
  return { items, nextCursor: more ? encodeCursor(last.id) : null };
}

/** Outbox envelope, same shape as every module's events (one topic keyed by tenant). */
export function procurementEvent(
  def: { type: string; version: number; parse(v: unknown): { id: string } },
  ctx: CommandContext,
  subject: string,
  data: unknown,
): OutboxEvent {
  const e = def.parse({
    id: ctx.ids.uuidv7(),
    type: def.type,
    version: def.version,
    source: "api/procurement",
    tenantId: ctx.tenant.tenantId,
    subject,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor: { type: "user", id: ctx.userId },
    data,
  });
  return {
    id: e.id,
    topic: PROCUREMENT_TOPIC,
    key: ctx.tenant.tenantId,
    type: def.type,
    version: def.version,
    payload: e,
  };
}
