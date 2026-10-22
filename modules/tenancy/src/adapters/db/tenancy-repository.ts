import { DomainError } from "@wise-biz/errors";

import { MAX_MY_TENANTS } from "../../ports/tenancy-repository.ts";

import type { BusinessRows } from "../../domain/business.ts";
import type { Membership, MyTenantRow, TenancyRepository } from "../../ports/tenancy-repository.ts";
import type { Conditions, PolicyRow } from "@wise-biz/policy";

const UNIQUE_VIOLATION = "23505";

interface MembershipDbRow {
  id: string;
  branch_ids: string[] | null;
  permissions_version: number;
  roles: string[];
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
    // Index: role_permissions_tenant_role_idx (tenant_id, role_id, id) + roles_pkey.
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
};
