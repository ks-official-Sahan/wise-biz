import { isValidConditions, type Conditions } from "./conditions.ts";
import { isPlatformPermission, type Permission, type PermissionCatalog } from "./permissions.ts";
import { isTenantRole, OWNER_ROLE, SYSTEM_ROLES } from "./roles.ts";

export type Grant = Readonly<{ permission: Permission; conditions?: Conditions }>;
/** role -> grants. A role may hold the same permission several times; any passing grant allows. */
export type PolicyMatrix = Readonly<Record<string, readonly Grant[]>>;
export type PolicyRow = Readonly<{ role: string; permission: string; conditions?: Conditions }>;

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
  return Object.freeze(Object.fromEntries(grants));
}

/** auth-kit `Matrix` shape (`Record<role, ReadonlySet<permission>>`). Conditions are dropped. */
export function toAuthKitMatrix(matrix: PolicyMatrix): Record<string, ReadonlySet<Permission>> {
  return Object.fromEntries(
    Object.entries(matrix).map(([role, grants]) => [
      role,
      new Set(grants.map((g) => g.permission)),
    ]),
  );
}
