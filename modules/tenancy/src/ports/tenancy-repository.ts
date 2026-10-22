import type { BusinessRows } from "../domain/business.ts";
import type { TxHandle } from "@wise-biz/db";
import type { PolicyRow } from "@wise-biz/policy";

export type Tx = TxHandle;

export interface Clock {
  now(): number;
}
export interface Ids {
  uuidv7(): string;
}

export interface Membership {
  membershipId: string;
  roles: string[];
  /** "all" = NULL branch_ids. */
  branchScope: "all" | string[];
  permissionsVersion: number;
}

export interface MyTenantRow {
  tenantId: string;
  name: string;
  membershipId: string;
}

/** Max active memberships (businesses) one user may hold; signUpBusiness refuses beyond it (409 CONFLICT). */
export const MAX_MEMBERSHIPS_PER_USER = 20;

/** Hard cap on "my tenants" so one query can never grow without bound. */
export const MAX_MY_TENANTS = 200;

export interface TenancyRepository {
  /** All rows of a new business. Throws DomainError CONFLICT when the tenant id already exists (FIRST statement). */
  insertBusiness(tx: Tx, rows: BusinessRows): Promise<void>;
  /** ONE query: active memberships of a user joined with active tenants. Runs under withUserTx. */
  listMyTenants(tx: Tx, userId: string): Promise<MyTenantRow[]>;
  /** ONE query under withUserTx: how many active memberships the user holds, and whether one is in `tenantId`. */
  membershipStats(
    tx: Tx,
    userId: string,
    tenantId: string,
  ): Promise<{ count: number; inTenant: boolean }>;
  /** ONE query. Runs under withUserTx (no tenant set). */
  hasActiveMembership(tx: Tx, userId: string, tenantId: string): Promise<boolean>;
  /** ONE query: active membership + roles + tenant permissions_version; null when absent, suspended or tenant suspended. */
  loadMembership(tx: Tx, userId: string, tenantId: string): Promise<Membership | null>;
  /** ONE query: every grant of the tenant as role/permission/conditions rows. */
  loadPolicyRows(tx: Tx, tenantId: string): Promise<PolicyRow[]>;
}

/** Narrow port to the identity module's session store; the kernel injects it (identity <- tenancy, never the reverse). */
export interface ActiveTenantSetter {
  /** The session row is matched on BOTH ids, so a caller can only move its own session. */
  setActiveTenant(sessionId: string, userId: string, tenantId: string | null): Promise<void>;
}
