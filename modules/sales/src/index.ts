import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { SALES_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";

import type { WbModule } from "@wise-biz/module-kit";

export {
  OverrideApprovedV1,
  ReturnCompletedV1,
  SaleCompletedV1,
  SaleVoidedV1,
  SALES_TOPIC,
  ShiftClosedV1,
  ShiftOpenedV1,
} from "./events.ts";
export type { ZReport } from "./events.ts";
/**
 * Command handlers: transport-agnostic, each runs inside the caller's tenant transaction and writes its own audit row
 * and outbox events. The sync transport (P1-06) verifies the device signature and chain, then calls them.
 */
export { completeSale } from "./application/sale.ts";
export type { Applied, SaleReceipt } from "./application/sale.ts";
export { openShift } from "./application/shift.ts";
export type { ShiftReceipt } from "./application/shift.ts";
export { closeShift } from "./application/close-shift.ts";
export { recordOverride } from "./application/override.ts";
export type { OverrideReceipt } from "./application/override.ts";
export { voidSale } from "./application/void.ts";
export type { VoidReceipt } from "./application/void.ts";
export { completeReturn } from "./application/return.ts";
export type { ReturnReceipt } from "./application/return.ts";
export { cashMovement, openDrawer } from "./application/cash.ts";
export type { CashReceipt } from "./application/cash.ts";
export { DEFAULT_OPTIONS } from "./ports.ts";
export type {
  BatchFacts,
  InventoryPort,
  OperatorFacts,
  PricingPort,
  QuoteInput,
  QuoteResult,
  SalesOptions,
  SalesPorts,
  StockMovement,
  TenancyPort,
  TerminalContext,
} from "./ports.ts";

/** Sales documents from terminals: sales, returns, voids, shifts, drawers, cash movements, overrides, invoices. */
export function createSalesModule(): WbModule {
  return defineModule({
    name: "sales",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: definePermissions("sales", [
      "read",
      "sell",
      "shift",
      "return",
      "return_no_receipt",
      "void",
      "void_late",
      "price_override",
      "open_drawer",
      "cash",
    ]),
    events: [...SALES_EVENTS],
    // Reads only: commands arrive through sync (P1-06), which applies them with the handlers above.
    routes: (app, deps) => {
      mountRoutes(app, deps);
    },
  });
}
