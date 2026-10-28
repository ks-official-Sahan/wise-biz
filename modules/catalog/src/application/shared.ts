import { DomainError } from "@wise-biz/errors";

import { CATALOG_TOPIC } from "../events.ts";

import type { OutboxEvent } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";

export const notFound = (): never => {
  throw new DomainError("NOT_FOUND", "Not found");
};

export const stale = (): never => {
  throw new DomainError("CONFLICT", "Someone else changed this. Reload and try again.");
};

const UNIQUE: Readonly<Record<string, string>> = {
  variants_sku_key: "This SKU is already used by another variant.",
  variants_pkey: "A variant with this id already exists.",
  products_pkey: "A product with this id already exists.",
  barcodes_code_key: "This barcode is already used by another variant.",
  categories_sibling_name_key: "A category with this name already exists here.",
  categories_pkey: "A category with this id already exists.",
  tags_name_key: "This tag already exists.",
  tags_pkey: "A tag with this id already exists.",
  units_code_key: "A unit with this code already exists.",
  units_pkey: "A unit with this id already exists.",
  unit_conversions_pair_key: "This conversion already exists.",
};
const REFERENCE: Readonly<Record<string, [path: string, message: string]>> = {
  products_category_fk: ["categoryId", "Unknown category."],
  categories_parent_fk: ["parentId", "Unknown parent category."],
  product_tags_tag_fk: ["tagIds", "Unknown tag."],
  variants_unit_fk: ["unitId", "Unknown unit."],
  unit_conversions_from_fk: ["fromUnitId", "Unknown unit."],
  unit_conversions_to_fk: ["toUnitId", "Unknown unit."],
};

/**
 * Constraint violations become client errors: unique = 409 with a readable reason, a dangling reference = 422 on the
 * field. The transaction is aborted either way, so this only rethrows.
 */
export async function pgErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const { code, constraint } = e as { code?: string; constraint?: string };
    if (code === "23505" && constraint !== undefined && constraint in UNIQUE) {
      throw new DomainError("CONFLICT", UNIQUE[constraint] ?? "Already exists.");
    }
    const ref = constraint === undefined ? undefined : REFERENCE[constraint];
    if (code === "23503" && ref !== undefined) {
      throw new DomainError("VALIDATION_FAILED", ref[1], {
        fieldErrors: [{ path: ref[0], message: ref[1] }],
      });
    }
    throw e;
  }
}

export function catalogEvent(
  def: { type: string; version: number; parse(v: unknown): { id: string } },
  ctx: CommandContext,
  subject: string,
  data: unknown,
): OutboxEvent {
  const e = def.parse({
    id: ctx.ids.uuidv7(),
    type: def.type,
    version: def.version,
    source: "api/catalog",
    tenantId: ctx.tenant.tenantId,
    subject,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor: { type: "user", id: ctx.userId },
    data,
  });
  return {
    id: e.id,
    topic: CATALOG_TOPIC,
    key: ctx.tenant.tenantId,
    type: def.type,
    version: def.version,
    payload: e,
  };
}
