import { join } from "node:path";

import { withTenantTx } from "@wise-biz/db";
import { defineModule } from "@wise-biz/module-kit";

import { drizzleTenancyRepository } from "./adapters/db/tenancy-repository.ts";
import { mountRoutes } from "./adapters/http/routes.ts";
import { TENANCY_EVENTS } from "./events.ts";
import { TENANCY_PERMISSIONS } from "./permissions.ts";

import type { ActiveTenantSetter, Membership } from "./ports/tenancy-repository.ts";
import type { WbModule } from "@wise-biz/module-kit";
import type { PolicyRow } from "@wise-biz/policy";
import type pg from "pg";

export { drizzleTenancyRepository } from "./adapters/db/tenancy-repository.ts";
export { DEFAULT_ROLE_GRANTS, newBusiness } from "./domain/business.ts";
export {
  TENANCY_EVENTS,
  TENANCY_TENANT_TOPIC,
  TenantCreatedV1,
  TenantMemberInvitedV1,
} from "./events.ts";
export { TENANCY_PERMISSIONS } from "./permissions.ts";
export {
  createInviteEmailConsumer,
  INVITE_EMAIL_CONSUMER,
  inviteAcceptLink,
} from "./consumers/invite-email.ts";
export type { InviteEmailConsumer, InviteEmailDeps } from "./consumers/invite-email.ts";
export { seedDemoTenant } from "./seed-demo.ts";
export type { DemoMember, SeedDemoInput } from "./seed-demo.ts";
export type { MailSender } from "./ports/mail.ts";
export { inviteToken, inviteTokenMatches } from "./invite-token.ts";
export type { ActiveTenantSetter, Membership } from "./ports/tenancy-repository.ts";

export interface TenancyModuleOptions {
  /** INVITE_SECRET (kernel env). Absent = invite acceptance refuses every token (fail closed). */
  readonly inviteSecret?: string | undefined;
}

/**
 * The tenancy module. `sessions` is the narrow port to the identity session store (injected by the API kernel:
 * identity <- tenancy, tenancy never imports identity).
 */
export function createTenancyModule(
  sessions: ActiveTenantSetter,
  options: TenancyModuleOptions = {},
): WbModule {
  return defineModule({
    name: "tenancy",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: TENANCY_PERMISSIONS,
    events: TENANCY_EVENTS,
    routes: (app, deps) => {
      mountRoutes(app, deps, sessions, drizzleTenancyRepository, {
        inviteSecret: options.inviteSecret,
      });
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
