import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { SALES_EVENTS } from "./events.ts";

import type { WbModule } from "@wise-biz/module-kit";

export { SaleCompletedV1, ShiftOpenedV1, SALES_TOPIC } from "./events.ts";
/**
 * Command handlers: transport-agnostic, each runs inside the caller's tenant transaction and writes its own audit row
 * and outbox events. The sync transport (P1-06) verifies the device signature and chain, then calls them.
 */
export { completeSale } from "./application/sale.ts";
export type { Applied, SaleReceipt } from "./application/sale.ts";
export { openShift } from "./application/shift.ts";
export type { ShiftReceipt } from "./application/shift.ts";
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
    // Read APIs land in 05c; commands arrive through sync (P1-06).
    routes: () => undefined,
  });
}
