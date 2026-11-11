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

const countLine = z.object({ variantId: z.string(), batchId: z.string().nullable() });

/** A count was created (snapshot taken). Scans are not evented: the close event carries the summary. */
export const CountCreatedV1 = defineEvent(
  "inventory.count.created",
  1,
  z.object({
    countId: z.string(),
    locationId: z.string(),
    kind: z.enum(["full", "cycle"]),
    mode: z.enum(["frozen", "live"]),
    blind: z.boolean(),
    lineCount: z.number().int(),
  }),
);

export const CountStartedV1 = defineEvent(
  "inventory.count.started",
  1,
  z.object({ countId: z.string(), locationId: z.string() }),
);

/** Lines sent back for another count (review -> open, or a recount request while counting). */
export const CountRecountRequestedV1 = defineEvent(
  "inventory.count.recount_requested",
  1,
  z.object({ countId: z.string(), locationId: z.string(), lines: z.array(countLine) }),
);

/** Counting closed: the expectation is frozen at the close cut and the count awaits review. */
export const CountClosedV1 = defineEvent(
  "inventory.count.closed",
  1,
  z.object({
    countId: z.string(),
    locationId: z.string(),
    lineCount: z.number().int(),
    uncountedLines: z.number().int(),
  }),
);

/** Approved: its variances were posted as count_variance movements in the same transaction. */
/**
 * Value fields (netValueMinor, unvaluedLines) are present for blind counts too: the payload is not changed by
 * blindness. Consumers must filter by role (counts:approve) before showing values to anyone else.
 */
export const CountApprovedV1 = defineEvent(
  "inventory.count.approved",
  1,
  z.object({
    countId: z.string(),
    locationId: z.string(),
    adjustedLines: z.number().int(),
    /** Sum of the valued variances in the count currency; null when a line has no known cost. */
    netValueMinor: z.number().int().nullable(),
    unvaluedLines: z.number().int(),
  }),
);

export const CountCancelledV1 = defineEvent(
  "inventory.count.cancelled",
  1,
  z.object({
    countId: z.string(),
    locationId: z.string(),
    fromStatus: z.enum(["draft", "open", "review"]),
  }),
);

/** A variance line of an approved count became a gap case (once per count line). */
export const GapDetectedV1 = defineEvent(
  "inventory.gap.detected",
  1,
  z.object({
    caseId: z.string(),
    countId: z.string(),
    locationId: z.string(),
    variantId: z.string(),
    batchId: z.string().nullable(),
    varianceQty: qty,
    /** Null when the line has no known cost (never 0). */
    valueMinor: z.number().int().nullable(),
    currency: z.string(),
  }),
);

/** Status, assignee or a task of a case changed. `changes` names what moved (no values). */
export const GapUpdatedV1 = defineEvent(
  "inventory.gap.updated",
  1,
  z.object({
    caseId: z.string(),
    locationId: z.string(),
    variantId: z.string(),
    status: z.enum(["open", "investigating", "resolved"]),
    changes: z.array(z.enum(["status", "assignee", "task_added", "task_updated"])),
  }),
);

/** Resolved (terminal). A misplaced-found resolution also posted stock: its movement is a separate movement.recorded. */
export const GapResolvedV1 = defineEvent(
  "inventory.gap.resolved",
  1,
  z.object({
    caseId: z.string(),
    countId: z.string(),
    locationId: z.string(),
    variantId: z.string(),
    resolutionCode: z.enum(["theft", "damage", "data_error", "misplaced_found", "supplier_short"]),
    foundLocationId: z.string().nullable(),
    foundQty: qty.nullable(),
  }),
);

/**
 * A promotion DRAFT for an expiring batch (P2-04c). Pricing consumes it later and decides; inventory moves no stock and
 * sets no price. `expiresOn` is the batch's expiry (UTC date); `percent` is a multiple of 5 from the rule in domain/expiry.ts.
 */
export const ExpiryMarkdownSuggestedV1 = defineEvent(
  "inventory.expiry.markdown_suggested",
  1,
  z.object({
    batchId: z.string(),
    variantId: z.string(),
    locationId: z.string(),
    expiresOn: z.string(),
    daysLeft: z.number().int(),
    percent: z.number().int().min(0).max(50),
    state: z.literal("draft"),
    stockAheadQty: qty,
    soldQty: qty,
    windowDays: z.number().int(),
    currency: z.string(),
    salePriceMinor: z.number().int().nullable(),
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
  CountCreatedV1,
  CountStartedV1,
  CountRecountRequestedV1,
  CountClosedV1,
  CountApprovedV1,
  CountCancelledV1,
  GapDetectedV1,
  GapUpdatedV1,
  GapResolvedV1,
  ExpiryMarkdownSuggestedV1,
] as const;
