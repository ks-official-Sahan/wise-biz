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

export interface InviteRow {
  inviteId: string;
  email: string;
  roleIds: string[];
  /** null = every branch. */
  branchIds: string[] | null;
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export interface MemberRow {
  membershipId: string;
  userId: string;
  status: "active" | "suspended";
  roles: string[];
  branchIds: string[] | null;
  createdAt: Date;
}

export interface RoleRow {
  roleId: string;
  name: string;
  isSystem: boolean;
  grants: { permission: string; conditions: unknown }[];
}

export interface BranchRow {
  branchId: string;
  name: string;
  kind: string;
  timezone: string;
  currency: string;
  taxRegion: string;
  businessDayCutoff: string;
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

  /** Name of the tenant in the tx scope, or null. */
  tenantName(tx: Tx, tenantId: string): Promise<string | null>;

  /** Pending = neither accepted nor revoked (expired still counts as pending). */
  findPendingInviteByEmail(tx: Tx, tenantId: string, email: string): Promise<InviteRow | null>;
  findInvite(tx: Tx, tenantId: string, inviteId: string): Promise<InviteRow | null>;
  insertInvite(
    tx: Tx,
    tenantId: string,
    row: Omit<InviteRow, "acceptedAt" | "revokedAt">,
  ): Promise<void>;
  /** Sets revoked_at on a pending invite. false when it was not pending (already accepted or revoked). */
  revokeInvite(tx: Tx, tenantId: string, inviteId: string, at: Date): Promise<boolean>;
  /** Marks a pending invite accepted. false when it was not pending. */
  markInviteAccepted(
    tx: Tx,
    tenantId: string,
    inviteId: string,
    userId: string,
    at: Date,
  ): Promise<boolean>;
  /** ONE query, keyset on (created_at, id) desc. Pending invites only. `after` = last invite id of the previous page. */
  listPendingInvites(tx: Tx, tenantId: string, limit: number, after?: string): Promise<InviteRow[]>;

  /** Ids of the given roles that exist in the tenant, with their names. ONE query. */
  findRoles(
    tx: Tx,
    tenantId: string,
    roleIds: readonly string[],
  ): Promise<{ id: string; name: string }[]>;
  /** Ids of the given branches that exist in the tenant. ONE query. */
  findBranchIds(tx: Tx, tenantId: string, branchIds: readonly string[]): Promise<string[]>;
  /** The owner role id of the tenant, or null (never for a real tenant). */
  ownerRoleId(tx: Tx, tenantId: string): Promise<string | null>;

  /** Any membership of this user in the tenant (any status), or null. */
  membershipForUser(
    tx: Tx,
    tenantId: string,
    userId: string,
  ): Promise<{ id: string; status: string } | null>;
  insertMembership(
    tx: Tx,
    row: {
      tenantId: string;
      id: string;
      userId: string;
      branchIds: readonly string[] | null;
      createdAt: Date;
    },
  ): Promise<void>;
  insertMembershipRoles(
    tx: Tx,
    tenantId: string,
    membershipId: string,
    roleIds: readonly string[],
  ): Promise<void>;
  /** ONE query, newest first (UUIDv7 ids), keyset on membership id. Roles and branch scope in the same row. */
  listMembers(tx: Tx, tenantId: string, limit: number, after?: string): Promise<MemberRow[]>;
  /** ONE query: a single member with its role names, or null. */
  loadMember(tx: Tx, tenantId: string, membershipId: string): Promise<MemberRow | null>;
  /** ONE query: active memberships other than `membershipId` that hold the owner role. */
  countOtherActiveOwners(
    tx: Tx,
    tenantId: string,
    ownerRoleId: string,
    membershipId: string,
  ): Promise<number>;
  /** Serialises membership/owner changes of one tenant for the rest of the tx (advisory xact lock). */
  lockMembershipChanges(tx: Tx, tenantId: string): Promise<void>;
  replaceMembershipRoles(
    tx: Tx,
    tenantId: string,
    membershipId: string,
    roleIds: readonly string[],
  ): Promise<void>;
  setMembershipBranches(
    tx: Tx,
    tenantId: string,
    membershipId: string,
    branchIds: readonly string[] | null,
  ): Promise<void>;

  /** ONE query: every role of the tenant with its grants (JSON aggregate). */
  listRoles(tx: Tx, tenantId: string): Promise<RoleRow[]>;
  findRole(
    tx: Tx,
    tenantId: string,
    roleId: string,
  ): Promise<{ id: string; name: string; isSystem: boolean } | null>;
  countCustomRoles(tx: Tx, tenantId: string): Promise<number>;
  insertRole(
    tx: Tx,
    row: { tenantId: string; id: string; name: string; createdAt: Date },
  ): Promise<void>;
  /** Deletes every grant of the role, then inserts `grants`. Two statements, so the version bumps twice (harmless). */
  replaceRoleGrants(
    tx: Tx,
    tenantId: string,
    roleId: string,
    grants: readonly { id: string; permission: string; conditions: unknown }[],
    createdAt: Date,
  ): Promise<void>;

  /** ONE query, keyset not needed: bounded by the caller (branches per tenant are few). */
  listBranches(
    tx: Tx,
    tenantId: string,
    scope: "all" | readonly string[],
    limit: number,
  ): Promise<BranchRow[]>;
  findBranch(tx: Tx, tenantId: string, branchId: string): Promise<BranchRow | null>;
  insertBranch(tx: Tx, row: BranchRow & { tenantId: string; createdAt: Date }): Promise<void>;
}

/** Narrow port to the identity module's session store; the kernel injects it (identity <- tenancy, never the reverse). */
export interface ActiveTenantSetter {
  /** The session row is matched on BOTH ids, so a caller can only move its own session. */
  setActiveTenant(sessionId: string, userId: string, tenantId: string | null): Promise<void>;
}
