import { DomainError } from "@wise-biz/errors";
import {
  OWNER_ROLE,
  isPlatformPermission,
  isValidConditions,
  PLATFORM_ADMIN_ROLE,
} from "@wise-biz/policy";

import type { Conditions, Permission, PermissionCatalog } from "@wise-biz/policy";

/** Same shape as the tenancy.roles CHECK constraint. */
export const CUSTOM_ROLE_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
/** Bounds the role list (and so the roles query) per tenant. */
export const MAX_CUSTOM_ROLES = 50;
/** Bounds the grants of one role. The catalog is far smaller; this only stops an abusive request. */
export const MAX_GRANTS_PER_ROLE = 200;

export interface GrantInput {
  readonly permission: string;
  readonly conditions?: unknown;
}

export interface GrantRow {
  readonly permission: Permission;
  readonly conditions: Conditions | null;
}

function fail(path: string, message: string): never {
  throw new DomainError("VALIDATION_FAILED", `${path}: ${message}`, {
    fieldErrors: [{ path, message }],
  });
}

/** A custom role name: lower-case snake, never a reserved name. System names are rejected by the unique key. */
export function assertCustomRoleName(name: string): string {
  if (!CUSTOM_ROLE_NAME_RE.test(name)) {
    fail(
      "name",
      "must be lower-case letters, digits and underscores, starting with a letter (max 63)",
    );
  }
  if (name === PLATFORM_ADMIN_ROLE || name === OWNER_ROLE) fail("name", "is reserved");
  return name;
}

/**
 * Validates a complete replacement set of grants against the runtime catalog (platform permissions are never
 * tenant-grantable) and the policy condition schema. Returns rows ready to insert, in input order.
 */
export function validateGrants(
  grants: readonly GrantInput[],
  catalog: PermissionCatalog,
): GrantRow[] {
  if (grants.length > MAX_GRANTS_PER_ROLE)
    fail("grants", `at most ${String(MAX_GRANTS_PER_ROLE)} grants`);
  const seen = new Set<string>();
  return grants.map((g, i) => {
    const path = `grants.${String(i)}.permission`;
    if (!catalog.has(g.permission) || isPlatformPermission(g.permission)) {
      fail(path, "unknown permission");
    }
    if (seen.has(g.permission)) fail(path, "duplicate permission");
    seen.add(g.permission);
    if (g.conditions === undefined || g.conditions === null) {
      return { permission: g.permission, conditions: null };
    }
    if (!isValidConditions(g.conditions))
      fail(`grants.${String(i)}.conditions`, "invalid conditions");
    return { permission: g.permission, conditions: g.conditions };
  });
}
