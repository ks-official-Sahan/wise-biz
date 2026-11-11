import { DomainError } from "@wise-biz/errors";

import { INVENTORY_TOPIC } from "../events.ts";

import type { OutboxEvent } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";

export const notFound = (): never => {
  throw new DomainError("NOT_FOUND", "Not found");
};

export const stale = (): never => {
  throw new DomainError("CONFLICT", "Someone else changed this. Reload and try again.");
};

export const invalid = (path: string, message: string): never => {
  throw new DomainError("VALIDATION_FAILED", message, { fieldErrors: [{ path, message }] });
};

const UNIQUE: Readonly<Record<string, string>> = {
  receipts_pkey: "A receipt with this id already exists.",
  adjustments_pkey: "An adjustment with this id already exists.",
  batches_pkey: "A batch with this id already exists.",
  stock_counts_pkey: "A count with this id already exists.",
  stock_counts_one_active_uq: "A count is already open at this location.",
};
const REFERENCE: Readonly<Record<string, [path: string, message: string]>> = {
  receipt_lines_batch_fk: ["lines", "Unknown batch."],
  adjustment_lines_batch_fk: ["lines", "Unknown batch."],
};

/** Unique violations become 409, dangling references 422 on the field (the transaction is aborted either way). */
export async function pgErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const { code, constraint } = e as { code?: string; constraint?: string };
    if (code === "23505" && constraint !== undefined && constraint in UNIQUE) {
      throw new DomainError("CONFLICT", UNIQUE[constraint] ?? "Already exists.");
    }
    const ref = constraint === undefined ? undefined : REFERENCE[constraint];
    if (code === "23503" && ref !== undefined) invalid(ref[0], ref[1]);
    throw e;
  }
}

export function inventoryEvent(
  def: { type: string; version: number; parse(v: unknown): { id: string } },
  ctx: CommandContext,
  subject: string,
  data: unknown,
  /** events.md: the inventory topic is keyed tenantId:variantId (per-SKU order across all its events). */
  variantId: string,
): OutboxEvent {
  const e = def.parse({
    id: ctx.ids.uuidv7(),
    type: def.type,
    version: def.version,
    source: "api/inventory",
    tenantId: ctx.tenant.tenantId,
    subject,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor: { type: "user", id: ctx.userId },
    data,
  });
  return {
    id: e.id,
    topic: INVENTORY_TOPIC,
    key: `${ctx.tenant.tenantId}:${variantId}`,
    type: def.type,
    version: def.version,
    payload: e,
  };
}

export const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The row a `returning` or locked select just produced (present by construction). */
export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  /* v8 ignore next */
  if (row === undefined) throw new Error("internal: expected one row");
  return row;
}
