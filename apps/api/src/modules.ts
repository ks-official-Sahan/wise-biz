import { createAuditModule } from "@wise-biz/module-audit";
import { createCatalogModule } from "@wise-biz/module-catalog";
import { createDevicesModule } from "@wise-biz/module-devices";
import { batchSalePrices, createInventoryModule } from "@wise-biz/module-inventory";
import { notificationsModule } from "@wise-biz/module-notifications";
import { createPricingModule } from "@wise-biz/module-pricing";
import { createReportingModule } from "@wise-biz/module-reporting";
import { createSalesModule } from "@wise-biz/module-sales";
import { createSearchModule } from "@wise-biz/module-search";
import { shortlinksModule } from "@wise-biz/module-shortlinks";
import { createSyncModule } from "@wise-biz/module-sync";
import { templateModule } from "@wise-biz/module-template";
import { createTenancyModule } from "@wise-biz/module-tenancy";
import { themingModule } from "@wise-biz/module-theming";
import { createMemoryStore } from "@wise-biz/storage";

import { createSyncPorts } from "./sync-ports.ts";

import type { NonceStore } from "@wise-biz/http-signatures";
import type { BranchExists, IsActiveMember } from "@wise-biz/module-devices";
import type { LocationExists } from "@wise-biz/module-inventory";
import type { WbModule } from "@wise-biz/module-kit";
import type { OnSyncMetric, RealtimeOptions } from "@wise-biz/module-sync";
import type { ActiveTenantSetter, TenancyModuleOptions } from "@wise-biz/module-tenancy";
import type { ObjectStore } from "@wise-biz/storage";

/**
 * Mounted modules, in registry order (modules/registry.json; identity is global and mounted by the kernel at
 * /v1/auth/*). devOnly ones are skipped in production. Tenancy gets its narrow session port and its invite secret from
 * the kernel.
 */
export function createModules(
  sessions: ActiveTenantSetter,
  tenancy: TenancyModuleOptions = {},
  devices: { nonces: NonceStore; pinPepper: string } = {
    nonces: unwiredNonces,
    pinPepper: "docs-only-pepper-never-used-for-real-pins",
  },
  /** Object storage (imports, media). The docs/test default keeps objects in memory. */
  store: ObjectStore = createMemoryStore(),
  /** Realtime stream tickets (apps/realtime); omitted when the service is not configured. */
  realtime?: RealtimeOptions,
  /** Sync push metrics sink (apply latency, batch size, rejections). */
  syncMetric?: OnSyncMetric,
): readonly WbModule[] {
  return [
    createAuditModule(),
    createTenancyModule(sessions, tenancy),
    createDevicesModule({
      branchExists,
      nonces: devices.nonces,
      pin: { pepper: new TextEncoder().encode(devices.pinPepper), isActiveMember },
    }),
    createCatalogModule({ store }),
    // A batch with its own sale price wins over the list in the quote (inventory owns batches).
    createPricingModule({ batchPrices: batchSalePrices }),
    createInventoryModule({ locationExists }),
    // Commands arrive through sync (P1-06), which applies them with salesPorts (sales-ports.ts).
    createSalesModule(),
    // Terminals push signed command batches here; each command goes to its owning module through syncPorts.
    createSyncModule(createSyncPorts(store, syncMetric), {}, realtime),
    createSearchModule(),
    // Public digital receipts (/r/:code); the sale-to-link consumer runs in apps/workers.
    shortlinksModule,
    // The store's look: versioned themes and receipt templates (P1-13c).
    themingModule,
    // MIS reports read the rollups the worker maintains (P1-14).
    createReportingModule({ store }),
    notificationsModule,
    templateModule,
  ];
}

/**
 * Devices needs "does this branch exist in the tenant?" and tenancy owns branches. The composition root bridges the
 * two with one indexed query in the caller's tenant transaction (RLS applies), so neither module reads the other.
 */
const branchExists: BranchExists = async (tx, tenantId, branchId) => {
  const r = await tx.query(
    "select 1 from tenancy.branches where tenant_id = $1 and id = $2 and archived_at is null",
    [tenantId, branchId],
  );
  return r.rowCount === 1;
};

/** Stock lives at locations, and tenancy owns them (same bridge as branchExists). */
const locationExists: LocationExists = async (tx, tenantId, locationId) => {
  const r = await tx.query("select 1 from tenancy.locations where tenant_id = $1 and id = $2", [
    tenantId,
    locationId,
  ]);
  return r.rowCount === 1;
};

/** PIN logins need an ACTIVE membership in the terminal's business (tenancy owns memberships). */
const isActiveMember: IsActiveMember = async (tx, tenantId, userId) => {
  const r = await tx.query(
    "select 1 from tenancy.memberships where tenant_id = $1 and user_id = $2 and status = 'active'",
    [tenantId, userId],
  );
  return r.rowCount === 1;
};

const unwiredNonces: NonceStore = {
  claim: () => Promise.reject(new Error("device nonces are not wired")),
};

/** Route/permission shapes only (OpenAPI generation, tests): the session port is not wired and must never be called. */
export const docModules: readonly WbModule[] = createModules(
  { setActiveTenant: () => Promise.reject(new Error("docModules: session port is not wired")) },
  {},
  undefined,
  undefined,
  // So the OpenAPI document lists the stream-ticket route; the secret never signs a real ticket.
  { secret: "docs-only-secret-never-used-for-real-tickets", url: "https://realtime.example.test" },
);
