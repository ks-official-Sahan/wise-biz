import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/** events.md: one topic, keyed by tenant, so a product's events and its variants' events stay in order. */
export const CATALOG_TOPIC = "catalog";

const names = z.array(z.string());

/** Product fields that search and the POS cache show next to every variant. */
export const ProductUpsertedV1 = defineEvent(
  "catalog.product.upserted",
  1,
  z.object({
    productId: z.string(),
    name: z.string(),
    categoryId: z.string().nullable(),
    /** Category names root..leaf at the time of the change (consumers never read catalog tables). */
    categoryPath: names,
    tags: names,
    archived: z.boolean(),
  }),
);

/** Self-sufficient: the search projection indexes a variant from this payload alone (modules never share tables). */
export const VariantUpsertedV1 = defineEvent(
  "catalog.variant.upserted",
  1,
  z.object({
    productId: z.string(),
    variantId: z.string(),
    productName: z.string(),
    name: z.string(),
    sku: z.string(),
    barcodes: names,
    unitId: z.string().nullable(),
    taxCategory: z.string(),
    tracksBatches: z.boolean(),
    categoryPath: names,
    tags: names,
    archived: z.boolean(),
  }),
);

export const VariantArchivedV1 = defineEvent(
  "catalog.variant.archived",
  1,
  z.object({ productId: z.string(), variantId: z.string() }),
);

/** The full code set after the change, plus what moved, so a POS barcode map can apply it without a refetch. */
export const BarcodeChangedV1 = defineEvent(
  "catalog.barcode.changed",
  1,
  z.object({
    productId: z.string(),
    variantId: z.string(),
    codes: names,
    added: names,
    removed: names,
  }),
);

/** Starts (or resumes) an import job in the workers (ADR 0012). */
export const ImportRequestedV1 = defineEvent(
  "catalog.import.requested",
  1,
  z.object({ importId: z.string() }),
);

export const CATALOG_EVENTS = [
  ProductUpsertedV1,
  VariantUpsertedV1,
  VariantArchivedV1,
  BarcodeChangedV1,
  ImportRequestedV1,
] as const;
