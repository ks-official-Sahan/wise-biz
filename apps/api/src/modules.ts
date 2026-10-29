import { createAuditModule } from "@wise-biz/module-audit";
import { createCatalogModule } from "@wise-biz/module-catalog";
import { createDevicesModule } from "@wise-biz/module-devices";
import { createSearchModule } from "@wise-biz/module-search";
import { templateModule } from "@wise-biz/module-template";
import { createTenancyModule } from "@wise-biz/module-tenancy";
import { createMemoryStore } from "@wise-biz/storage";

import type { NonceStore } from "@wise-biz/http-signatures";
import type { BranchExists, IsActiveMember } from "@wise-biz/module-devices";
import type { WbModule } from "@wise-biz/module-kit";
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
    createSearchModule(),
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
export const docModules: readonly WbModule[] = createModules({
  setActiveTenant: () => Promise.reject(new Error("docModules: session port is not wired")),
});
