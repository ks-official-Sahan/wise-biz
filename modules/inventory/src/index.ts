import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { INVENTORY_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";

import type { LocationExists } from "./application/stock.ts";
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
  MovementInput,
  MovementReason,
  RecordResult,
  Source,
} from "./port.ts";
export { fromQty4, NO_BATCH, toQty4 } from "./domain/qty.ts";

/** Ledger, balances, batches (FEFO), reservations, receiving, adjustments, thresholds. */
export function createInventoryModule(opts: { locationExists: LocationExists }): WbModule {
  return defineModule({
    name: "inventory",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: [
      ...definePermissions("inventory", ["read", "receive", "adjust", "write", "sell_expired"]),
      // Stock counts: reading and counting are separate from approving the variances they post.
      ...definePermissions("counts", ["read", "write", "approve"]),
    ],
    events: [...INVENTORY_EVENTS],
    routes: (app, deps) => {
      mountRoutes(app, deps, opts.locationExists);
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
