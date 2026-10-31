import { z } from "zod";

import type { PoolClient } from "pg";

/**
 * Tolerant reader of `catalog.variant.upserted@v1`: only what stock needs (consumer-driven contract, no import of the
 * catalog module).
 */
const VariantUpserted = z.object({
  tenantId: z.string(),
  time: z.string(),
  data: z.object({
    variantId: z.string(),
    tracksBatches: z.boolean(),
    archived: z.boolean(),
  }),
});

export const INVENTORY_FACTS_CONSUMER = "inventory.variant-facts";

/** Upserts one variant's facts; an older event never overwrites a newer row (redelivery, reordering). */
export async function applyVariantFacts(client: PoolClient, payload: unknown): Promise<void> {
  const e = VariantUpserted.parse(payload);
  await client.query(
    `insert into inventory.variant_facts (tenant_id, variant_id, tracks_batches, archived, source_time)
     values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, variant_id) do update set tracks_batches = excluded.tracks_batches,
       archived = excluded.archived, source_time = excluded.source_time
     where inventory.variant_facts.source_time <= excluded.source_time`,
    [e.tenantId, e.data.variantId, e.data.tracksBatches, e.data.archived, e.time],
  );
}

export interface InventoryFactsConsumer {
  readonly name: string;
  readonly events: readonly string[];
  readonly maxAttempts: number;
  readonly handle: (
    event: { readonly payload: unknown },
    ctx: { readonly client: PoolClient },
  ) => Promise<void>;
}

/** Structural twin of @wise-biz/events ConsumerDefinition (the workers pass it to the bus by shape). */
export function createInventoryFactsConsumer(): InventoryFactsConsumer {
  return {
    name: INVENTORY_FACTS_CONSUMER,
    events: ["catalog.variant.upserted@v1"],
    maxAttempts: 5,
    handle: (event, ctx) => applyVariantFacts(ctx.client, event.payload),
  };
}
