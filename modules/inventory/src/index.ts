import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { INVENTORY_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";

import type { LocationExists } from "./application/stock.ts";
import type { GapEvidencePorts } from "./port.ts";
import type { WbModule } from "@wise-biz/module-kit";

export {
  BalanceLowV1,
  BalanceNegativeV1,
  BatchExpiringV1,
  BatchReceivedV1,
  BatchUpdatedV1,
  CountApprovedV1,
  CountCancelledV1,
  CountClosedV1,
  CountCreatedV1,
  CountRecountRequestedV1,
  CountStartedV1,
  DriftDetectedV1,
  ExpiryMarkdownSuggestedV1,
  GapDetectedV1,
  GapResolvedV1,
  GapUpdatedV1,
  MovementRecordedV1,
} from "./events.ts";
export { createInventoryFactsConsumer, INVENTORY_FACTS_CONSUMER } from "./projection.ts";
export type { InventoryFactsConsumer } from "./projection.ts";
export { batchSalePrices } from "./application/stock.ts";
export type { LocationExists } from "./application/stock.ts";
/** InventoryPort: in-process contract for sales and orders (same DB transaction while the monolith lasts). */
export {
  commitReservations,
  lockStock,
  recordMovements,
  releaseReservations,
  reserve,
  selectBatchesFefo,
} from "./port.ts";
export type {
  Balance,
  FefoAllocation,
  GapEvidenceItem,
  GapEvidencePorts,
  GapEvidenceQuery,
  GapEvidenceSource,
  GapEvidenceSourceName,
  MovementInput,
  MovementReason,
  RecordResult,
  Source,
} from "./port.ts";
export { GAP_EVIDENCE_SOURCES, GAP_LEDGER_REASONS } from "./port.ts";
export { RESOLUTION_CODES } from "./domain/gap.ts";
export { fromQty4, NO_BATCH, toQty4 } from "./domain/qty.ts";

/**
 * Ledger, balances, batches (FEFO), reservations, receiving, adjustments, thresholds, counts and stock-gap cases.
 * `gapEvidence` wires the sales-owned evidence sources (voids, returns without receipt, price overrides, operators on
 * shift); an absent source is reported as unavailable on every gap case, never as zero events.
 */
export function createInventoryModule(opts: {
  locationExists: LocationExists;
  gapEvidence?: GapEvidencePorts;
}): WbModule {
  return defineModule({
    name: "inventory",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: [
      ...definePermissions("inventory", ["read", "receive", "adjust", "write", "sell_expired"]),
      // Stock counts: reading and counting are separate from approving the variances they post.
      ...definePermissions("counts", ["read", "write", "approve"]),
      // Stock-gap cases: reading (with the evidence panel), working the case, and resolving it.
      ...definePermissions("gaps", ["read", "write", "resolve"]),
      // Expiry: the near-expiry list and the FEFO report read; markdown drafts and write-offs are the write side.
      ...definePermissions("expiry", ["read", "writeoff"]),
    ],
    events: [...INVENTORY_EVENTS],
    routes: (app, deps) => {
      mountRoutes(app, deps, opts.locationExists, opts.gapEvidence ?? {});
    },
  });
}
export {
  createLowStockConsumer,
  ensureInventoryPartitions,
  evaluateLowStock,
  exclusive,
  LOW_STOCK_CONSUMER,
  runDriftCheck,
  runExpiringBatches,
} from "./jobs.ts";
export type { JobDeps } from "./jobs.ts";
