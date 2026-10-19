/** `module:action` or `module:action:scope`, lowercase snake segments. */
export type Permission = `${string}:${string}` | `${string}:${string}:${string}`;

const PERMISSION_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)?$/;

/** Module whose permissions are platform-only and never grantable to tenant roles. */
export const PLATFORM_MODULE = "platform";

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_RE.test(value);
}

export function isPlatformPermission(permission: string): boolean {
  return permission.startsWith(`${PLATFORM_MODULE}:`);
}

/** A module registers its permissions once; the list is frozen and format-checked. */
export function definePermissions(
  module: string,
  actions: readonly string[],
): readonly Permission[] {
  const list = actions.map((action) => {
    const permission = `${module}:${action}`;
    if (!isPermission(permission)) throw new Error(`Invalid permission "${permission}"`);
    return permission;
  });
  return Object.freeze(list);
}

export type PermissionCatalog = Readonly<{
  all: readonly Permission[];
  has: (permission: unknown) => permission is Permission;
}>;

/** Merge module lists. Rejects duplicates and malformed entries. */
export function createCatalog(...lists: readonly (readonly string[])[]): PermissionCatalog {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const permission of list) {
      if (!isPermission(permission)) throw new Error(`Invalid permission "${permission}"`);
      if (seen.has(permission)) throw new Error(`Duplicate permission "${permission}"`);
      seen.add(permission);
    }
  }
  const all = Object.freeze([...seen] as Permission[]);
  return Object.freeze({
    all,
    has: (permission: unknown): permission is Permission =>
      typeof permission === "string" && seen.has(permission),
  });
}
