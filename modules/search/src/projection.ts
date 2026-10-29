import { z } from "zod";

import type { PoolClient } from "pg";

/**
 * Tolerant reader of `catalog.variant.upserted@v1`: only the fields search needs (consumer-driven contract, no import of
 * the catalog module). Unknown fields are ignored, so catalog can add fields without breaking search.
 */
const VariantUpserted = z.object({
  tenantId: z.string(),
  time: z.string(),
  data: z.object({
    productId: z.string(),
    variantId: z.string(),
    productName: z.string(),
    name: z.string(),
    sku: z.string(),
    barcodes: z.array(z.string()),
    categoryPath: z.array(z.string()),
    tags: z.array(z.string()),
    archived: z.boolean(),
  }),
});

export const SEARCH_PROJECTION_CONSUMER = "search.catalog-projection";

/** "Coca-Cola" + "1.5L" -> one title; a variant named like its product ("Default") adds nothing. */
export function title(productName: string, variantName: string): string {
  const v = variantName.trim();
  return v === "" ||
    v.toLowerCase() === productName.trim().toLowerCase() ||
    v.toLowerCase() === "default"
    ? productName.trim()
    : `${productName.trim()} ${v}`;
}

/**
 * Upserts one variant document. Runs in the consumer transaction scoped to the event's tenant (RLS applies). An older
 * event never overwrites a newer document (`source_time`), so redelivery or reordering cannot regress the index.
 * catalog re-emits every variant on product and category changes, so variant events are the only input needed.
 */
export async function applyVariantUpserted(client: PoolClient, payload: unknown): Promise<void> {
  const e = VariantUpserted.parse(payload);
  const d = e.data;
  await client.query(
    `insert into search.search_documents
       (tenant_id, kind, entity_id, product_id, title, sku, barcodes, category_path, tags, archived, tsv, source_time,
        updated_at)
     values ($1, 'variant', $2, $3, $4, $5, $6, $7, $8, $9, search.doc_tsv($4, $5, $8, $7), $10, now())
     on conflict (tenant_id, kind, entity_id) do update set
       product_id = excluded.product_id, title = excluded.title, sku = excluded.sku, barcodes = excluded.barcodes,
       category_path = excluded.category_path, tags = excluded.tags, archived = excluded.archived, tsv = excluded.tsv,
       source_time = excluded.source_time, updated_at = now()
     where search.search_documents.source_time <= excluded.source_time`,
    [
      e.tenantId,
      d.variantId,
      d.productId,
      title(d.productName, d.name),
      d.sku,
      d.barcodes,
      d.categoryPath,
      d.tags,
      d.archived,
      e.time,
    ],
  );
}

export interface SearchProjectionConsumer {
  readonly name: string;
  readonly events: readonly string[];
  readonly maxAttempts: number;
  readonly handle: (
    event: { readonly payload: unknown },
    ctx: { readonly client: PoolClient },
  ) => Promise<void>;
}

/** Structural twin of @wise-biz/events ConsumerDefinition (the workers pass it to the bus, which accepts it by shape). */
export function createSearchProjectionConsumer(): SearchProjectionConsumer {
  return {
    name: SEARCH_PROJECTION_CONSUMER,
    events: ["catalog.variant.upserted@v1"],
    maxAttempts: 5,
    handle: (event, ctx) => applyVariantUpserted(ctx.client, event.payload),
  };
}
