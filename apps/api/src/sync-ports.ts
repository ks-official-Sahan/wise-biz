import { devicePublicKey, quarantineDevice } from "@wise-biz/module-devices";
import {
  cashMovement,
  closeShift,
  completeReturn,
  completeSale,
  openDrawer,
  openShift,
  recordOverride,
  voidSale,
} from "@wise-biz/module-sales";

import { salesPorts } from "./sales-ports.ts";

import type { OnSyncMetric, SyncPorts } from "@wise-biz/module-sync";
import type { ObjectStore } from "@wise-biz/storage";

/**
 * Sync verifies a terminal's signed commands and hands each to the module that owns it. Wired here so sync never
 * imports sales or devices: the handlers, the device key lookup and the quarantine are the only seams.
 */
export const createSyncPorts = (store: ObjectStore, onMetric?: OnSyncMetric): SyncPorts => ({
  ...(onMetric === undefined ? {} : { onMetric }),
  handlers: {
    complete_sale: (tx, t, cmd) => completeSale(tx, salesPorts, t, cmd),
    complete_return: (tx, t, cmd) => completeReturn(tx, salesPorts, t, cmd),
    void_sale: (tx, t, cmd) => voidSale(tx, salesPorts, t, cmd),
    open_shift: (tx, t, cmd) => openShift(tx, salesPorts, t, cmd),
    close_shift: (tx, t, cmd) => closeShift(tx, salesPorts, t, cmd),
    open_drawer: (tx, t, cmd) => openDrawer(tx, salesPorts, t, cmd),
    cash_movement: (tx, t, cmd) => cashMovement(tx, salesPorts, t, cmd),
    record_override: (tx, t, cmd) => recordOverride(tx, salesPorts, t, cmd),
  },
  deviceKey: devicePublicKey,
  quarantine: quarantineDevice,
  // Stock changes are scoped by location and tenancy owns locations: one indexed query, in the caller's tenant tx.
  branchLocations: async (tx, tenantId, branchId) => {
    const r = await tx.query<{ id: string }>(
      "select id from tenancy.locations where tenant_id = $1 and branch_id = $2 order by id",
      [tenantId, branchId],
    );
    return r.rows.map((x) => x.id);
  },
  store,
});
