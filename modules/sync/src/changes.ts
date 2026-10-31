import { z } from "zod";

import { noticesOf } from "./realtime.ts";

import type { Dataset } from "./datasets.ts";
import type { ChangeNotice } from "./realtime.ts";
import type { PoolClient } from "pg";

export { DATASETS, isDataset } from "./datasets.ts";
export type { Dataset } from "./datasets.ts";

export interface ChangeRow {
  readonly dataset: Dataset;
  readonly scopeKey: string;
  readonly entity: string;
  readonly entityId: string;
  readonly op: "upsert" | "delete";
  readonly version: number;
  readonly payload: unknown;
}

/**
 * Tolerant reader of the producers' events (consumer-driven: no import of the owning modules). Producers' events are
 * fat, so the payload is the entity as the device needs it. Unknown shapes throw, and the bus retries or dead-letters.
 */
const Envelope = z.object({
  type: z.string(),
  tenantId: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const str = z.string();
/** A required string field of the event data: a missing one is a producer bug, so it throws (retry, dead-letter). */
const need = (d: Record<string, unknown>, key: string): string => {
  const v = d[key];
  if (typeof v !== "string" || v === "") throw new Error(`sync.changes: event data lacks "${key}"`);
  return v;
};
const Balances = z.object({
  balances: z.array(
    z.object({
      locationId: str,
      batchId: str.nullable(),
      qty: str,
      reserved: str,
    }),
  ),
  variantId: str,
});

const upsert = (
  dataset: Dataset,
  entity: string,
  entityId: string,
  data: unknown,
  version = 0,
  scopeKey = "all",
): ChangeRow => ({ dataset, scopeKey, entity, entityId, op: "upsert", version, payload: data });
const remove = (dataset: Dataset, entity: string, entityId: string, version = 0): ChangeRow => ({
  dataset,
  scopeKey: "all",
  entity,
  entityId,
  op: "delete",
  version,
  payload: null,
});
const versionOf = (d: Record<string, unknown>) => (typeof d.version === "number" ? d.version : 0);

/** The pure mapping: one event in, the change rows it causes out (empty for events sync does not carry). */
export function changesOf(payload: unknown): { tenantId: string; rows: ChangeRow[] } {
  const e = Envelope.parse(payload);
  const d = e.data;
  const rows = ((): ChangeRow[] => {
    switch (e.type) {
      case "catalog.product.upserted":
        return [upsert("catalog", "product", need(d, "productId"), d)];
      case "catalog.variant.upserted":
        return [upsert("catalog", "variant", need(d, "variantId"), d)];
      case "catalog.variant.archived":
        return [remove("catalog", "variant", need(d, "variantId"))];
      case "pricing.price_list.upserted":
        return [upsert("prices", "price_list", need(d, "priceListId"), d, versionOf(d))];
      case "pricing.price.changed": {
        const x = z
          .object({
            priceListId: str,
            version: z.number().int(),
            changes: z.array(z.object({ variantId: str, priceMinor: z.number().int().nullable() })),
          })
          .parse(d);
        return x.changes.map((c) => {
          const id = `${x.priceListId}:${c.variantId}`;
          return c.priceMinor === null
            ? remove("prices", "price", id, x.version)
            : upsert(
                "prices",
                "price",
                id,
                { priceListId: x.priceListId, variantId: c.variantId, priceMinor: c.priceMinor },
                x.version,
              );
        });
      }
      case "pricing.fx_rate.recorded":
        return [upsert("prices", "fx_rate", need(d, "fxRateId"), d)];
      case "pricing.tax_region.upserted":
        return [upsert("tax", "tax_region", need(d, "taxRegionId"), d, versionOf(d))];
      case "pricing.fee.upserted":
        return [upsert("tax", "fee", need(d, "feeId"), d, versionOf(d))];
      case "pricing.promotion.published":
        return [upsert("promotions", "promotion", need(d, "promotionId"), d, versionOf(d))];
      case "pricing.promotion.archived":
        return [remove("promotions", "promotion", need(d, "promotionId"), versionOf(d))];
      case "inventory.movement.recorded": {
        // Informational balances of a branch's stock; the scope is the location (pull resolves a branch's locations).
        const x = Balances.parse(d);
        return x.balances.map((b) =>
          upsert(
            "stock_branch",
            "stock",
            `${b.locationId}:${x.variantId}:${b.batchId ?? "-"}`,
            { variantId: x.variantId, ...b },
            0,
            b.locationId,
          ),
        );
      }
      default:
        return [];
    }
  })();
  return { tenantId: e.tenantId, rows };
}

export const SYNC_CHANGES_CONSUMER = "sync.changes";

export interface SyncChangesConsumer {
  readonly name: string;
  readonly events: readonly string[];
  readonly maxAttempts: number;
  readonly handle: (
    event: { readonly payload: unknown },
    ctx: { readonly client: PoolClient },
  ) => Promise<void>;
}

/** One statement for all the rows of an event (a price change can carry hundreds). */
export async function applyChanges(client: PoolClient, payload: unknown): Promise<number> {
  const { tenantId, rows } = changesOf(payload);
  await insertRows(client, tenantId, rows);
  return rows.length;
}

async function insertRows(
  client: PoolClient,
  tenantId: string,
  rows: readonly ChangeRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `insert into sync.sync_changes (tenant_id, dataset, scope_key, entity, entity_id, op, version, payload)
     select $1, r.dataset, r.scope_key, r.entity, r.entity_id, r.op, r.version, r.payload
     from jsonb_to_recordset($2::jsonb) as r(dataset text, scope_key text, entity text, entity_id text, op text,
       version bigint, payload jsonb)`,
    [
      tenantId,
      JSON.stringify(
        rows.map((r) => ({
          dataset: r.dataset,
          scope_key: r.scopeKey,
          entity: r.entity,
          entity_id: r.entityId,
          op: r.op,
          version: r.version,
          payload: r.payload,
        })),
      ),
    ],
  );
}

const EVENTS = [
  "catalog.product.upserted@v1",
  "catalog.variant.upserted@v1",
  "catalog.variant.archived@v1",
  "pricing.price_list.upserted@v1",
  "pricing.price.changed@v1",
  "pricing.fx_rate.recorded@v1",
  "pricing.tax_region.upserted@v1",
  "pricing.fee.upserted@v1",
  "pricing.promotion.published@v1",
  "pricing.promotion.archived@v1",
  "inventory.movement.recorded@v1",
] as const;

/**
 * Structural twin of @wise-biz/events ConsumerDefinition (the workers pass it to the bus by shape). `notify` hints
 * the realtime service that a dataset moved. It runs inside the handler's transaction, so a hint can beat the commit:
 * terminals treat it as "pull now" and keep a slow poll as the fallback (offline-sync.md). A failing notify never
 * fails the handler.
 */
export function createSyncChangesConsumer(
  notify?: (notice: ChangeNotice) => void,
): SyncChangesConsumer {
  return {
    name: SYNC_CHANGES_CONSUMER,
    events: EVENTS,
    maxAttempts: 5,
    handle: async (event, ctx) => {
      const { tenantId, rows } = changesOf(event.payload);
      await insertRows(ctx.client, tenantId, rows);
      if (notify === undefined) return;
      for (const n of noticesOf(tenantId, rows)) {
        try {
          notify(n);
        } catch {
          // best effort: the poll fallback covers a lost hint
        }
      }
    },
  };
}
