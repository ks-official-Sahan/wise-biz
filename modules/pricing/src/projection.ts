import { z } from "zod";

import type { PoolClient } from "pg";

/**
 * Tolerant reader of `catalog.variant.upserted@v1`: only what the quote needs (consumer-driven contract, no import of the
 * catalog module). `categoryIds` arrived after the first events, so it defaults to none.
 */
const VariantUpserted = z.object({
  tenantId: z.string(),
  time: z.string(),
  data: z.object({
    variantId: z.string(),
    taxCategory: z.string(),
    categoryIds: z.array(z.string()).default([]),
    archived: z.boolean(),
  }),
});

export const PRICING_FACTS_CONSUMER = "pricing.variant-facts";

/** Upserts one variant's facts; an older event never overwrites a newer row (redelivery, reordering). */
export async function applyVariantFacts(client: PoolClient, payload: unknown): Promise<void> {
  const e = VariantUpserted.parse(payload);
  await client.query(
    `insert into pricing.variant_facts (tenant_id, variant_id, tax_category, category_ids, archived, source_time)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id, variant_id) do update set tax_category = excluded.tax_category,
       category_ids = excluded.category_ids, archived = excluded.archived, source_time = excluded.source_time
     where pricing.variant_facts.source_time <= excluded.source_time`,
    [e.tenantId, e.data.variantId, e.data.taxCategory, e.data.categoryIds, e.data.archived, e.time],
  );
}

export interface PricingFactsConsumer {
  readonly name: string;
  readonly events: readonly string[];
  readonly maxAttempts: number;
  readonly handle: (
    event: { readonly payload: unknown },
    ctx: { readonly client: PoolClient },
  ) => Promise<void>;
}

/** Structural twin of @wise-biz/events ConsumerDefinition (the workers pass it to the bus by shape). */
export function createPricingFactsConsumer(): PricingFactsConsumer {
  return {
    name: PRICING_FACTS_CONSUMER,
    events: ["catalog.variant.upserted@v1"],
    maxAttempts: 5,
    handle: (event, ctx) => applyVariantFacts(ctx.client, event.payload),
  };
}
