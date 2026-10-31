import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/** events.md: one topic keyed by tenant, so a document's movements and the balances they cause stay in order. */
export const INVENTORY_TOPIC = "inventory";

const qty = z.string();

/** One per (source document, variant): the new movements of that SKU and its balances after the write. */
export const MovementRecordedV1 = defineEvent(
  "inventory.movement.recorded",
  1,
  z.object({
    variantId: z.string(),
    sourceType: z.string(),
    sourceId: z.string(),
    occurredAt: z.string(),
    movements: z.array(
      z.object({
        locationId: z.string(),
        batchId: z.string().nullable(),
        qty,
        reason: z.string(),
      }),
    ),
    /** Balances after the write (one per touched key): devices and the low-stock evaluator read these. */
    balances: z.array(
      z.object({
        locationId: z.string(),
        batchId: z.string().nullable(),
        qty,
        reserved: qty,
      }),
    ),
  }),
);

export const BalanceNegativeV1 = defineEvent(
  "inventory.balance.negative",
  1,
  z.object({
    locationId: z.string(),
    variantId: z.string(),
    batchId: z.string().nullable(),
    qty,
    sourceType: z.string(),
    sourceId: z.string(),
  }),
);

/** A new lot: its own cost, expiry and optional sale price (wins over the price list at the till). */
export const BatchReceivedV1 = defineEvent(
  "inventory.batch.received",
  1,
  z.object({
    batchId: z.string(),
    variantId: z.string(),
    lotCode: z.string().nullable(),
    expiresOn: z.string().nullable(),
    currency: z.string(),
    unitCostMinor: z.number().int(),
    salePriceMinor: z.number().int().nullable(),
    receivedAt: z.string(),
  }),
);

export const BatchUpdatedV1 = defineEvent(
  "inventory.batch.updated",
  1,
  z.object({
    batchId: z.string(),
    variantId: z.string(),
    salePriceMinor: z.number().int().nullable(),
  }),
);

/** Daily job: a batch with stock entered the expiry horizon (once per batch). */
export const BatchExpiringV1 = defineEvent(
  "inventory.batch.expiring",
  1,
  z.object({
    batchId: z.string(),
    variantId: z.string(),
    lotCode: z.string().nullable(),
    expiresOn: z.string(),
    /** Stock still on hand per location (positive balances only). */
    stock: z.array(z.object({ locationId: z.string(), qty })),
  }),
);

/** On-hand at a location fell below its threshold (once until it recovers: debounced by stock_thresholds.low_since). */
export const BalanceLowV1 = defineEvent(
  "inventory.balance.low",
  1,
  z.object({
    locationId: z.string(),
    variantId: z.string(),
    qty,
    minQty: qty,
    maxQty: qty.nullable(),
  }),
);

/** Nightly drift check: a balance disagrees with the sum of its ledger. Balances are NOT auto-corrected. */
export const DriftDetectedV1 = defineEvent(
  "inventory.drift.detected",
  1,
  z.object({
    locationId: z.string(),
    variantId: z.string(),
    batchId: z.string().nullable(),
    balanceQty: qty,
    ledgerQty: qty,
  }),
);

export const INVENTORY_EVENTS = [
  MovementRecordedV1,
  BalanceNegativeV1,
  BatchReceivedV1,
  BatchUpdatedV1,
  BatchExpiringV1,
  BalanceLowV1,
  DriftDetectedV1,
] as const;
