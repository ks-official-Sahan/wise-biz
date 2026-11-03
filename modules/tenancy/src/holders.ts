import type { PoolClient } from "pg";

/**
 * Active members who hold `permission` through a role, plus every owner (the owner role carries no explicit grants: it
 * can do everything). A member limited to some branches is included only when one of `scope.locationIds` sits in
 * those branches or one of `scope.branchIds` is one of them (no scope: no branch filter). Runs in the caller's tenant transaction, so RLS scopes it. Used by workers to decide who to tell.
 */
export async function permissionHolders(
  client: PoolClient,
  tenantId: string,
  permission: string,
  scope: { locationIds?: readonly string[]; branchIds?: readonly string[] } = {},
): Promise<string[]> {
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT DISTINCT m.user_id
       FROM tenancy.memberships m
       JOIN tenancy.membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
       JOIN tenancy.roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
      WHERE m.tenant_id = $1 AND m.status = 'active'
        AND (r.name = 'owner'
             OR EXISTS (SELECT 1 FROM tenancy.role_permissions rp
                         WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id AND rp.permission = $2))
        AND (m.branch_ids IS NULL OR (cardinality($3::uuid[]) = 0 AND cardinality($4::uuid[]) = 0)
             OR m.branch_ids && $4::uuid[]
             OR EXISTS (SELECT 1 FROM tenancy.locations l
                         WHERE l.tenant_id = m.tenant_id AND l.id = ANY($3::uuid[]) AND l.branch_id = ANY(m.branch_ids)))
      ORDER BY m.user_id`,
    [tenantId, permission, [...(scope.locationIds ?? [])], [...(scope.branchIds ?? [])]],
  );
  return rows.map((r) => r.user_id);
}
