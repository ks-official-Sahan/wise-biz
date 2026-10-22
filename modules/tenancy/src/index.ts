import { join } from "node:path";

import { withTenantTx } from "@wise-biz/db";
import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { drizzleTenancyRepository } from "./adapters/db/tenancy-repository.ts";
import { mountRoutes } from "./adapters/http/routes.ts";
import { TenantCreatedV1 } from "./events.ts";

import type { ActiveTenantSetter, Membership } from "./ports/tenancy-repository.ts";
import type { WbModule } from "@wise-biz/module-kit";
import type { PolicyRow } from "@wise-biz/policy";
import type pg from "pg";

export { drizzleTenancyRepository } from "./adapters/db/tenancy-repository.ts";
export { DEFAULT_ROLE_GRANTS, newBusiness } from "./domain/business.ts";
export { TENANCY_TENANT_TOPIC, TenantCreatedV1 } from "./events.ts";
export type { ActiveTenantSetter, Membership } from "./ports/tenancy-repository.ts";

export const TENANCY_PERMISSIONS = definePermissions("tenancy", ["read", "manage"]);

/**
 * The tenancy module. `sessions` is the narrow port to the identity session store (injected by the API kernel:
 * identity <- tenancy, tenancy never imports identity).
 */
export function createTenancyModule(sessions: ActiveTenantSetter): WbModule {
  return defineModule({
    name: "tenancy",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: TENANCY_PERMISSIONS,
    events: [TenantCreatedV1],
    routes: (app, deps) => {
      mountRoutes(app, deps, sessions);
    },
  });
}

/** What the API kernel needs from tenancy to resolve a request. */
export interface TenancyPorts {
  /** ONE query under the tenant's RLS scope. null = no active membership (fail closed). */
  loadMembership(userId: string, tenantId: string, requestId: string): Promise<Membership | null>;
  loadPolicyRows(tenantId: string, requestId: string): Promise<PolicyRow[]>;
}

export function createTenancyPorts(pool: pg.Pool, repo = drizzleTenancyRepository): TenancyPorts {
  return {
    loadMembership: (userId, tenantId, requestId) =>
      withTenantTx(pool, { tenantId, userId, requestId }, (tx) =>
        repo.loadMembership(tx, userId, tenantId),
      ),
    loadPolicyRows: (tenantId, requestId) =>
      withTenantTx(pool, { tenantId, requestId }, (tx) => repo.loadPolicyRows(tx, tenantId)),
  };
}
