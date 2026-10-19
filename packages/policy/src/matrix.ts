import { freezeConditions, isValidConditions, type Conditions } from "./conditions.ts";
import { isPlatformPermission, type Permission, type PermissionCatalog } from "./permissions.ts";
import { isTenantRole, OWNER_ROLE, SYSTEM_ROLES } from "./roles.ts";

export type Grant = Readonly<{ permission: Permission; conditions?: Conditions }>;
/**
 * role -> grants. A role may hold the same permission several times; any passing grant allows.
 * Shape is a plain record (compatible with hand-built and snapshot matrices). `decide` indexes
 * frozen matrices per permission lazily (see decide.ts), so the shape needs no wrapper.
 */
export type PolicyMatrix = Readonly<Record<string, readonly Grant[]>>;
export type PolicyRow = Readonly<{ role: string; permission: string; conditions?: Conditions }>;

/** Deep-frozen copy; no caller-owned reference stays reachable. Conditions must be valid. */
export function freezeGrant(g: Grant): Grant {
  return Object.freeze(
    g.conditions === undefined
      ? { permission: g.permission }
      : { permission: g.permission, conditions: freezeConditions(g.conditions) },
  );
}

/** Null-prototype, frozen matrix from role -> grants entries (grants copied and frozen). */
export function freezeMatrix(entries: Iterable<readonly [string, readonly Grant[]]>): PolicyMatrix {
  const out: Record<string, readonly Grant[]> = Object.create(null) as Record<string, never>;
  for (const [role, grants] of entries) out[role] = Object.freeze(grants.map(freezeGrant));
  return Object.freeze(out);
}

/**
 * Build a matrix from stored rows. Skips unknown roles, unknown permissions and malformed conditions.
 * Platform permissions are never granted. Owner is fixed: every non-platform permission, unconditional.
 */
export function matrixFromRows(
  catalog: PermissionCatalog,
  rows: readonly PolicyRow[],
): PolicyMatrix {
  const grants = new Map<string, Grant[]>(SYSTEM_ROLES.map((role) => [role, []]));
  grants.set(
    OWNER_ROLE,
    catalog.all.filter((p) => !isPlatformPermission(p)).map((permission) => ({ permission })),
  );
  for (const { role, permission, conditions } of rows) {
    if (role === OWNER_ROLE || !isTenantRole(role)) continue;
    if (!catalog.has(permission) || isPlatformPermission(permission)) continue;
    if (conditions !== undefined && !isValidConditions(conditions)) continue;
    let list = grants.get(role);
    if (list === undefined) grants.set(role, (list = []));
    list.push(conditions === undefined ? { permission } : { permission, conditions });
  }
  return freezeMatrix(grants);
}

/** auth-kit `Matrix` shape (`Record<role, ReadonlySet<permission>>`). Conditions and platform permissions are dropped. */
export function toAuthKitMatrix(matrix: PolicyMatrix): Record<string, ReadonlySet<Permission>> {
  const out: Record<string, ReadonlySet<Permission>> = Object.create(null) as Record<string, never>;
  for (const role of Object.keys(matrix)) {
    const grants = matrix[role] ?? [];
    out[role] = new Set(grants.map((g) => g.permission).filter((p) => !isPlatformPermission(p)));
  }
  return out;
}
