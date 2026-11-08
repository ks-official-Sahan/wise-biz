import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { PROCUREMENT_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";

import type { ProcurementDeps } from "./port.ts";
import type { WbModule } from "@wise-biz/module-kit";

export {
  PROCUREMENT_TOPIC,
  PurchaseOrderClosedV1,
  PurchaseOrderReceivedV1,
  PurchaseOrderSentV1,
  SupplierUpsertedV1,
  TransferClosedV1,
  TransferDispatchedV1,
  TransferReceivedV1,
} from "./events.ts";
export type {
  ProcurementDeps,
  RefsPort,
  StockBatchPick,
  StockMovement,
  StockPort,
} from "./port.ts";

/** Suppliers, supplier price lists, purchase orders and receiving (stock is written through the inventory port). */
export function createProcurementModule(deps: ProcurementDeps): WbModule {
  return defineModule({
    name: "procurement",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: definePermissions("procurement", ["read", "write", "receive"]),
    events: [...PROCUREMENT_EVENTS],
    routes: (app, mdeps) => {
      mountRoutes(app, mdeps, deps);
    },
  });
}
