import { DomainError } from "@wise-biz/errors";

import { MAX_MY_TENANTS } from "../../ports/tenancy-repository.ts";

import type { BusinessRows } from "../../domain/business.ts";
import type {
  BranchRow,
  InviteRow,
  Membership,
  MemberRow,
  MyTenantRow,
  RoleRow,
  TenancyRepository,
} from "../../ports/tenancy-repository.ts";
import type { Conditions, PolicyRow } from "@wise-biz/policy";

const UNIQUE_VIOLATION = "23505";

interface MembershipDbRow {
  id: string;
  branch_ids: string[] | null;
  permissions_version: number;
  roles: string[];
}

interface InviteDbRow {
  id: string;
  email: string;
  role_ids: string[];
  branch_ids: string[] | null;
  invited_by: string;
  expires_at: Date;
  created_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

interface MemberDbRow {
  id: string;
  user_id: string;
  status: "active" | "suspended";
  branch_ids: string[] | null;
  created_at: Date;
  roles: string[];
}

interface BranchDbRow {
  id: string;
  name: string;
  kind: string;
  timezone: string;
  currency: string;
  tax_region: string;
  cutoff: string;
}

const INVITE_COLS = `id, email, role_ids, branch_ids, invited_by, expires_at, created_at, accepted_at, revoked_at`;
const MEMBER_SELECT = `select m.id, m.user_id, m.status, m.branch_ids, m.created_at,
              coalesce(array_agg(r.name order by r.name) filter (where r.name is not null), '{}') as roles
       from tenancy.memberships m
       left join tenancy.membership_roles mr on mr.tenant_id = m.tenant_id and mr.membership_id = m.id
       left join tenancy.roles r on r.tenant_id = mr.tenant_id and r.id = mr.role_id`;

const toInvite = (r: InviteDbRow): InviteRow => ({
  inviteId: r.id,
  email: r.email,
  roleIds: r.role_ids,
  branchIds: r.branch_ids,
  invitedBy: r.invited_by,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  acceptedAt: r.accepted_at,
  revokedAt: r.revoked_at,
});

const toMember = (r: MemberDbRow): MemberRow => ({
  membershipId: r.id,
  userId: r.user_id,
  status: r.status,
  roles: r.roles,
  branchIds: r.branch_ids,
  createdAt: r.created_at,
});

const toBranch = (r: BranchDbRow): BranchRow => ({
  branchId: r.id,
  name: r.name,
  kind: r.kind,
  timezone: r.timezone,
  currency: r.currency,
  taxRegion: r.tax_region,
  businessDayCutoff: r.cutoff,
});

/** Maps a unique violation to CONFLICT with `message`; every other error passes through. */
async function conflictOnUnique<T>(message: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new DomainError("CONFLICT", message, { cause: err });
    }
    throw err;
  }
}

export const drizzleTenancyRepository: TenancyRepository = {
  async insertBusiness(tx, r: BusinessRows) {
    const t = r.tenant;
    // FIRST write: a tenant id that already exists (any owner) fails here with a PK conflict, before anything else is
    // written under that tenant's id. The transaction rolls back as a whole.
    try {
      await tx.query(
        "insert into tenancy.tenants (tenant_id, name, created_at) values ($1, $2, $3)",
        [t.tenantId, t.name, t.createdAt],
      );
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DomainError("CONFLICT", "tenant already exists", { cause: err });
      }
      throw err;
    }
    // Index: roles_pkey (tenant_id, id). One multi-row insert per table via unnest.
    await tx.query(
      `insert into tenancy.roles (tenant_id, id, name, is_system, created_at)
       select $1::uuid, x.id, x.name, true, $4::timestamptz from unnest($2::uuid[], $3::text[]) as x(id, name)`,
      [t.tenantId, r.roles.map((x) => x.id), r.roles.map((x) => x.name), r.createdAt],
    );
    if (r.rolePermissions.length > 0) {
      await tx.query(
        `insert into tenancy.role_permissions (tenant_id, id, role_id, permission, created_at)
         select $1::uuid, x.id, x.role_id, x.permission, $5::timestamptz
         from unnest($2::uuid[], $3::uuid[], $4::text[]) as x(id, role_id, permission)`,
        [
          t.tenantId,
          r.rolePermissions.map((x) => x.id),
          r.rolePermissions.map((x) => x.roleId),
          r.rolePermissions.map((x) => x.permission),
          r.createdAt,
        ],
      );
    }
    const b = r.branch;
    await tx.query(
      `insert into tenancy.branches
         (tenant_id, id, name, kind, timezone, currency, tax_region, business_day_cutoff, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::time, $9)`,
      [
        t.tenantId,
        b.id,
        b.name,
        b.kind,
        b.timezone,
        b.currency,
        b.taxRegion,
        b.businessDayCutoff,
        r.createdAt,
      ],
    );
    await tx.query(
      "insert into tenancy.locations (tenant_id, id, branch_id, name, created_at) values ($1, $2, $3, $4, $5)",
      [t.tenantId, r.location.id, r.location.branchId, r.location.name, r.createdAt],
    );
    await tx.query(
      "insert into tenancy.memberships (tenant_id, id, user_id, created_at) values ($1, $2, $3, $4)",
      [t.tenantId, r.membership.id, r.membership.userId, r.createdAt],
    );
    await tx.query(
      "insert into tenancy.membership_roles (tenant_id, membership_id, role_id) values ($1, $2, $3)",
      [t.tenantId, r.membership.id, r.ownerRoleId],
    );
  },

  async listMyTenants(tx, userId): Promise<MyTenantRow[]> {
    // Index: memberships_user_tenant_idx (user_id, tenant_id), then tenants_pkey. RLS: own_memberships / own_tenants.
    const res = await tx.query<{ tenant_id: string; name: string; membership_id: string }>(
      `select t.tenant_id, t.name, m.id as membership_id
       from tenancy.memberships m
       join tenancy.tenants t on t.tenant_id = m.tenant_id
       where m.user_id = $1 and m.status = 'active' and t.status = 'active'
       order by t.tenant_id
       limit ${String(MAX_MY_TENANTS)}`,
      [userId],
    );
    return res.rows.map((x) => ({
      tenantId: x.tenant_id,
      name: x.name,
      membershipId: x.membership_id,
    }));
  },

  async membershipStats(tx, userId, tenantId) {
    // Index: memberships_user_tenant_idx (user_id, tenant_id); at most MAX_MEMBERSHIPS_PER_USER-ish rows per user.
    const res = await tx.query<{ n: number; in_tenant: boolean }>(
      `select count(*)::int as n, coalesce(bool_or(tenant_id = $2), false) as in_tenant
       from tenancy.memberships where user_id = $1 and status = 'active'`,
      [userId, tenantId],
    );
    return { count: res.rows[0]?.n ?? 0, inTenant: res.rows[0]?.in_tenant ?? false };
  },

  async hasActiveMembership(tx, userId, tenantId) {
    // Index: memberships_tenant_user_key (tenant_id, user_id).
    const res = await tx.query(
      `select 1
       from tenancy.memberships m
       join tenancy.tenants t on t.tenant_id = m.tenant_id
       where m.tenant_id = $2 and m.user_id = $1 and m.status = 'active' and t.status = 'active'`,
      [userId, tenantId],
    );
    return res.rowCount === 1;
  },

  async loadMembership(tx, userId, tenantId): Promise<Membership | null> {
    // ONE query. Indexes: memberships_tenant_user_key (tenant_id, user_id) -> membership_roles_pkey
    // (tenant_id, membership_id, role_id) -> roles_pkey (tenant_id, id); tenants_pkey.
    const res = await tx.query<MembershipDbRow>(
      `select m.id, m.branch_ids, t.permissions_version,
              coalesce(array_agg(r.name order by r.name) filter (where r.name is not null), '{}') as roles
       from tenancy.memberships m
       join tenancy.tenants t on t.tenant_id = m.tenant_id and t.status = 'active'
       left join tenancy.membership_roles mr on mr.tenant_id = m.tenant_id and mr.membership_id = m.id
       left join tenancy.roles r on r.tenant_id = mr.tenant_id and r.id = mr.role_id
       where m.tenant_id = $2 and m.user_id = $1 and m.status = 'active'
       group by m.id, m.branch_ids, t.permissions_version`,
      [userId, tenantId],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    return {
      membershipId: row.id,
      roles: row.roles,
      branchScope: row.branch_ids ?? "all",
      permissionsVersion: row.permissions_version,
    };
  },

  async loadPolicyRows(tx, tenantId): Promise<PolicyRow[]> {
    // Index: role_permissions_role_permission_key (tenant_id, role_id, permission) + roles_pkey.
    const res = await tx.query<{ role: string; permission: string; conditions: Conditions | null }>(
      `select r.name as role, rp.permission, rp.conditions
       from tenancy.role_permissions rp
       join tenancy.roles r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
       where rp.tenant_id = $1
       order by rp.role_id, rp.id`,
      [tenantId],
    );
    return res.rows.map((x) =>
      x.conditions === null
        ? { role: x.role, permission: x.permission }
        : { role: x.role, permission: x.permission, conditions: x.conditions },
    );
  },

  async tenantName(tx, tenantId) {
    // Index: tenants_pkey.
    const res = await tx.query<{ name: string }>(
      "select name from tenancy.tenants where tenant_id = $1",
      [tenantId],
    );
    return res.rows[0]?.name ?? null;
  },

  async findPendingInviteByEmail(tx, tenantId, email) {
    // Index: invites_tenant_email_pending_key (tenant_id, email) WHERE pending.
    const res = await tx.query<InviteDbRow>(
      `select ${INVITE_COLS} from tenancy.invites
       where tenant_id = $1 and email = $2 and accepted_at is null and revoked_at is null`,
      [tenantId, email],
    );
    const row = res.rows[0];
    return row === undefined ? null : toInvite(row);
  },

  async findInvite(tx, tenantId, inviteId) {
    // Index: invites_pkey (tenant_id, id).
    const res = await tx.query<InviteDbRow>(
      `select ${INVITE_COLS} from tenancy.invites where tenant_id = $1 and id = $2`,
      [tenantId, inviteId],
    );
    const row = res.rows[0];
    return row === undefined ? null : toInvite(row);
  },

  async insertInvite(tx, tenantId, row) {
    await conflictOnUnique("a pending invite already exists for this email", () =>
      tx.query(
        `insert into tenancy.invites
           (tenant_id, id, email, role_ids, branch_ids, invited_by, expires_at, created_at)
         values ($1, $2, $3, $4::uuid[], $5::uuid[], $6, $7, $8)`,
        [
          tenantId,
          row.inviteId,
          row.email,
          [...row.roleIds],
          row.branchIds === null ? null : [...row.branchIds],
          row.invitedBy,
          row.expiresAt,
          row.createdAt,
        ],
      ),
    );
  },

  async revokeInvite(tx, tenantId, inviteId, at) {
    // Grant: UPDATE (revoked_at). Index: invites_pkey.
    const res = await tx.query(
      `update tenancy.invites set revoked_at = $3
       where tenant_id = $1 and id = $2 and accepted_at is null and revoked_at is null`,
      [tenantId, inviteId, at],
    );
    return res.rowCount === 1;
  },

  async markInviteAccepted(tx, tenantId, inviteId, userId, at) {
    // Grant: UPDATE (accepted_at, accepted_by). Index: invites_pkey.
    const res = await tx.query(
      `update tenancy.invites set accepted_at = $3, accepted_by = $4
       where tenant_id = $1 and id = $2 and accepted_at is null and revoked_at is null`,
      [tenantId, inviteId, at, userId],
    );
    return res.rowCount === 1;
  },

  async listPendingInvites(tx, tenantId, limit, after) {
    // ONE query. Index: invites_tenant_pending_created_idx (tenant_id, created_at desc, id desc) WHERE pending. The cursor row is resolved by
    // its primary key inside the same query; rows are never deleted, so a cursor always resolves.
    const res = await tx.query<InviteDbRow>(
      `select ${INVITE_COLS} from tenancy.invites
       where tenant_id = $1 and accepted_at is null and revoked_at is null
         and ($2::uuid is null or (created_at, id) < (
           select created_at, id from tenancy.invites where tenant_id = $1 and id = $2::uuid))
       order by created_at desc, id desc
       limit $3`,
      [tenantId, after ?? null, limit],
    );
    return res.rows.map(toInvite);
  },

  async findRoles(tx, tenantId, roleIds) {
    // Index: roles_pkey (tenant_id, id).
    const res = await tx.query<{ id: string; name: string }>(
      "select id, name from tenancy.roles where tenant_id = $1 and id = any($2::uuid[])",
      [tenantId, [...roleIds]],
    );
    return res.rows;
  },

  async findBranchIds(tx, tenantId, branchIds) {
    // Index: branches_pkey (tenant_id, id).
    const res = await tx.query<{ id: string }>(
      "select id from tenancy.branches where tenant_id = $1 and id = any($2::uuid[])",
      [tenantId, [...branchIds]],
    );
    return res.rows.map((r) => r.id);
  },

  async ownerRoleId(tx, tenantId) {
    // Index: roles_tenant_name_key (tenant_id, name).
    const res = await tx.query<{ id: string }>(
      "select id from tenancy.roles where tenant_id = $1 and name = 'owner'",
      [tenantId],
    );
    return res.rows[0]?.id ?? null;
  },

  async membershipForUser(tx, tenantId, userId) {
    // Index: memberships_tenant_user_key (tenant_id, user_id).
    const res = await tx.query<{ id: string; status: string }>(
      "select id, status from tenancy.memberships where tenant_id = $1 and user_id = $2",
      [tenantId, userId],
    );
    return res.rows[0] ?? null;
  },

  async insertMembership(tx, row) {
    await conflictOnUnique("already a member", () =>
      tx.query(
        `insert into tenancy.memberships (tenant_id, id, user_id, branch_ids, created_at)
         values ($1, $2, $3, $4::uuid[], $5)`,
        [
          row.tenantId,
          row.id,
          row.userId,
          row.branchIds === null ? null : [...row.branchIds],
          row.createdAt,
        ],
      ),
    );
  },

  async insertMembershipRoles(tx, tenantId, membershipId, roleIds) {
    // Index: membership_roles_pkey (tenant_id, membership_id, role_id).
    await tx.query(
      `insert into tenancy.membership_roles (tenant_id, membership_id, role_id)
       select $1::uuid, $2::uuid, x.role_id from unnest($3::uuid[]) as x(role_id)`,
      [tenantId, membershipId, [...roleIds]],
    );
  },

  async listMembers(tx, tenantId, limit, after) {
    // ONE query, no N+1: roles aggregated per membership. Index: memberships_pkey (tenant_id, id) walked backwards
    // (UUIDv7 ids are time-ordered, so id order is creation order), membership_roles_pkey, roles_pkey.
    const res = await tx.query<MemberDbRow>(
      `${MEMBER_SELECT}
       where m.tenant_id = $1 and ($2::uuid is null or m.id < $2::uuid)
       group by m.tenant_id, m.id
       order by m.id desc
       limit $3`,
      [tenantId, after ?? null, limit],
    );
    return res.rows.map(toMember);
  },

  async loadMember(tx, tenantId, membershipId) {
    // ONE query. Index: memberships_pkey, membership_roles_pkey, roles_pkey.
    const res = await tx.query<MemberDbRow>(
      `${MEMBER_SELECT}
       where m.tenant_id = $1 and m.id = $2
       group by m.tenant_id, m.id`,
      [tenantId, membershipId],
    );
    const row = res.rows[0];
    return row === undefined ? null : toMember(row);
  },

  async countOtherActiveOwners(tx, tenantId, ownerRoleId, membershipId) {
    // Index: membership_roles_tenant_role_idx (tenant_id, role_id), then memberships_pkey.
    const res = await tx.query<{ n: number }>(
      `select count(*)::int as n
       from tenancy.membership_roles mr
       join tenancy.memberships m on m.tenant_id = mr.tenant_id and m.id = mr.membership_id
       where mr.tenant_id = $1 and mr.role_id = $2 and m.status = 'active' and m.id <> $3`,
      [tenantId, ownerRoleId, membershipId],
    );
    return res.rows[0]?.n ?? 0;
  },

  async lockMembershipChanges(tx, tenantId) {
    // Advisory lock: needs no table privilege; released at commit or rollback.
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `tenancy.members:${tenantId}`,
    ]);
  },

  async replaceMembershipRoles(tx, tenantId, membershipId, roleIds) {
    // Grant: DELETE on membership_roles. Roles are read fresh per request, so no permissions_version bump is needed.
    await tx.query(
      "delete from tenancy.membership_roles where tenant_id = $1 and membership_id = $2",
      [tenantId, membershipId],
    );
    await tx.query(
      `insert into tenancy.membership_roles (tenant_id, membership_id, role_id)
       select $1::uuid, $2::uuid, x.role_id from unnest($3::uuid[]) as x(role_id)`,
      [tenantId, membershipId, [...roleIds]],
    );
  },

  async setMembershipBranches(tx, tenantId, membershipId, branchIds) {
    // Grant: UPDATE (status, branch_ids) on memberships. Index: memberships_pkey.
    await tx.query(
      "update tenancy.memberships set branch_ids = $3::uuid[] where tenant_id = $1 and id = $2",
      [tenantId, membershipId, branchIds === null ? null : [...branchIds]],
    );
  },

  async listRoles(tx, tenantId): Promise<RoleRow[]> {
    // ONE query. Indexes: roles_pkey (tenant_id, id); role_permissions_role_permission_key (tenant_id, role_id, permission).
    const res = await tx.query<{
      id: string;
      name: string;
      is_system: boolean;
      grants: { permission: string; conditions: unknown }[];
    }>(
      `select r.id, r.name, r.is_system,
              coalesce(jsonb_agg(jsonb_build_object('permission', rp.permission, 'conditions', rp.conditions)
                order by rp.permission) filter (where rp.id is not null), '[]'::jsonb) as grants
       from tenancy.roles r
       left join tenancy.role_permissions rp on rp.tenant_id = r.tenant_id and rp.role_id = r.id
       where r.tenant_id = $1
       group by r.tenant_id, r.id
       order by r.name`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      roleId: r.id,
      name: r.name,
      isSystem: r.is_system,
      grants: r.grants,
    }));
  },

  async findRole(tx, tenantId, roleId) {
    // Index: roles_pkey (tenant_id, id).
    const res = await tx.query<{ id: string; name: string; is_system: boolean }>(
      "select id, name, is_system from tenancy.roles where tenant_id = $1 and id = $2",
      [tenantId, roleId],
    );
    const row = res.rows[0];
    return row === undefined ? null : { id: row.id, name: row.name, isSystem: row.is_system };
  },

  async countCustomRoles(tx, tenantId) {
    // Index: roles_pkey (tenant_id, id) prefix scan.
    const res = await tx.query<{ n: number }>(
      "select count(*)::int as n from tenancy.roles where tenant_id = $1 and is_system = false",
      [tenantId],
    );
    return res.rows[0]?.n ?? 0;
  },

  async insertRole(tx, row) {
    await conflictOnUnique("a role with this name already exists", () =>
      tx.query(
        "insert into tenancy.roles (tenant_id, id, name, is_system, created_at) values ($1, $2, $3, false, $4)",
        [row.tenantId, row.id, row.name, row.createdAt],
      ),
    );
  },

  async replaceRoleGrants(tx, tenantId, roleId, grants, createdAt) {
    // Grant: DELETE on role_permissions (there is no UPDATE grant: a replacement is delete + insert). The statement-level
    // trigger bumps tenants.permissions_version, so the next request rebuilds the policy matrix.
    await tx.query("delete from tenancy.role_permissions where tenant_id = $1 and role_id = $2", [
      tenantId,
      roleId,
    ]);
    if (grants.length === 0) return;
    await tx.query(
      `insert into tenancy.role_permissions (tenant_id, id, role_id, permission, conditions, created_at)
       select $1::uuid, x.id, $2::uuid, x.permission, x.conditions::jsonb, $3::timestamptz
       from unnest($4::uuid[], $5::text[], $6::text[]) as x(id, permission, conditions)`,
      [
        tenantId,
        roleId,
        createdAt,
        grants.map((g) => g.id),
        grants.map((g) => g.permission),
        grants.map((g) => (g.conditions === null ? null : JSON.stringify(g.conditions))),
      ],
    );
  },

  async listBranches(tx, tenantId, scope, limit) {
    // ONE query. Index: branches_pkey (tenant_id, id).
    const res = await tx.query<BranchDbRow>(
      `select id, name, kind, timezone, currency, tax_region, to_char(business_day_cutoff, 'HH24:MI') as cutoff
       from tenancy.branches
       where tenant_id = $1 and ($2::uuid[] is null or id = any($2::uuid[]))
       order by id
       limit $3`,
      [tenantId, scope === "all" ? null : [...scope], limit],
    );
    return res.rows.map(toBranch);
  },

  async findBranch(tx, tenantId, branchId) {
    // Index: branches_pkey (tenant_id, id).
    const res = await tx.query<BranchDbRow>(
      `select id, name, kind, timezone, currency, tax_region, to_char(business_day_cutoff, 'HH24:MI') as cutoff
       from tenancy.branches where tenant_id = $1 and id = $2`,
      [tenantId, branchId],
    );
    const row = res.rows[0];
    return row === undefined ? null : toBranch(row);
  },

  async insertBranch(tx, row) {
    await tx.query(
      `insert into tenancy.branches
         (tenant_id, id, name, kind, timezone, currency, tax_region, business_day_cutoff, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::time, $9)`,
      [
        row.tenantId,
        row.branchId,
        row.name,
        row.kind,
        row.timezone,
        row.currency,
        row.taxRegion,
        row.businessDayCutoff,
        row.createdAt,
      ],
    );
  },
};
