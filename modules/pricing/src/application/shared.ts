import { DomainError } from "@wise-biz/errors";

import { PRICING_TOPIC } from "../events.ts";

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
  tax_regions_code_key: "A tax region with this code already exists.",
  tax_regions_pkey: "A tax region with this id already exists.",
  tax_rules_pkey: "A tax rule with this id already exists.",
  price_lists_pkey: "A price list with this id already exists.",
  fees_pkey: "A fee with this id already exists.",
  promotions_pkey: "A promotion with this id already exists.",
  coupons_code_key: "This coupon code is already used.",
  coupons_pkey: "A coupon with this id already exists.",
  fx_rates_pkey: "An FX rate with this id already exists.",
};
const REFERENCE: Readonly<Record<string, [path: string, message: string]>> = {
  price_lists_region_fk: ["taxRegionId", "Unknown tax region."],
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

export function pricingEvent(
  def: { type: string; version: number; parse(v: unknown): { id: string } },
  ctx: CommandContext,
  subject: string,
  data: unknown,
): OutboxEvent {
  const e = def.parse({
    id: ctx.ids.uuidv7(),
    type: def.type,
    version: def.version,
    source: "api/pricing",
    tenantId: ctx.tenant.tenantId,
    subject,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor: { type: "user", id: ctx.userId },
    data,
  });
  return {
    id: e.id,
    topic: PRICING_TOPIC,
    key: ctx.tenant.tenantId,
    type: def.type,
    version: def.version,
    payload: e,
  };
}

export const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
/** pg returns bigint as string; every amount here is <= MAX_SAFE_INTEGER (CHECK constraints). */
export const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** The row a `returning` or locked select just produced (present by construction). */
export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  /* v8 ignore next */
  if (row === undefined) throw new Error("internal: expected one row");
  return row;
}
