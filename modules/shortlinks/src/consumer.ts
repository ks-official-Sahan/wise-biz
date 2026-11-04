import { receiptCode } from "@wise-biz/receipt";

import { SaleCompletedEnvelope, snapshotOf } from "./snapshot.ts";

import type { PoolClient } from "pg";

export const SHORTLINKS_CONSUMER = "shortlinks.receipt-links";
const SALE_COMPLETED = "sales.sale.completed@v1";

/**
 * Writes the receipt link of one sale inside the consumer's transaction (the bus has set app.tenant_id to the event's
 * tenant, so RLS WITH CHECK rejects a row for any other tenant). Idempotent on (tenant_id, sale_id): a redelivery
 * inserts nothing and returns false. The code is recomputed from the sale id, the same way the terminal printed it.
 */
export async function applyReceiptLink(client: PoolClient, payload: unknown): Promise<boolean> {
  const e = SaleCompletedEnvelope.parse(payload);
  const r = await client.query(
    `insert into shortlinks.receipt_links (tenant_id, code, sale_id, snapshot)
     values ($1, $2, $3, $4::jsonb)
     on conflict (tenant_id, sale_id) do nothing`,
    [e.tenantId, receiptCode(e.data.saleId), e.data.saleId, JSON.stringify(snapshotOf(e.data))],
  );
  return r.rowCount === 1;
}

export interface ReceiptLinkConsumer {
  readonly name: string;
  readonly events: readonly string[];
  readonly maxAttempts: number;
  readonly handle: (
    event: { readonly payload: unknown },
    ctx: { readonly client: PoolClient },
  ) => Promise<void>;
}

/** Structural twin of @wise-biz/events ConsumerDefinition (the workers pass it to the bus, which accepts it by shape). */
export function createReceiptLinkConsumer(): ReceiptLinkConsumer {
  return {
    name: SHORTLINKS_CONSUMER,
    events: [SALE_COMPLETED],
    maxAttempts: 5,
    handle: async (event, ctx) => {
      await applyReceiptLink(ctx.client, event.payload);
    },
  };
}
