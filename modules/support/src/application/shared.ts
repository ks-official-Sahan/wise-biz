import { DomainError } from "@wise-biz/errors";

import { SUPPORT_TOPIC } from "../events.ts";

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

export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) return notFound();
  return row;
}

export const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * Keyset cursor for tickets ordered by (created_at desc, id desc): opaque base64url of "<created_at ISO>|<id>".
 * Validated on the way in, so a forged cursor is a 422 and never reaches SQL.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const [at, id, ...rest] = text.split("|");
  if (at === undefined || id === undefined || rest.length > 0 || !UUID_RE.test(id)) {
    invalid("after", "invalid cursor");
  }
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime())) invalid("after", "invalid cursor");
  return { createdAt, id };
}

/** Fetch limit + 1 rows; the extra row proves there is a next page without a count query. */
export function page<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (last: T) => string,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const more = rows.length > limit && last !== undefined;
  return { items, nextCursor: more ? cursorOf(last) : null };
}

/** Outbox envelope, same shape as every module's events (one topic keyed by tenant). */
export function supportEvent(
  def: { type: string; version: number; parse(v: unknown): { id: string } },
  ctx: CommandContext,
  subject: string,
  data: unknown,
): OutboxEvent {
  const e = def.parse({
    id: ctx.ids.uuidv7(),
    type: def.type,
    version: def.version,
    source: "api/support",
    tenantId: ctx.tenant.tenantId,
    subject,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor: { type: "user", id: ctx.userId },
    data,
  });
  return {
    id: e.id,
    topic: SUPPORT_TOPIC,
    key: ctx.tenant.tenantId,
    type: def.type,
    version: def.version,
    payload: e,
  };
}
