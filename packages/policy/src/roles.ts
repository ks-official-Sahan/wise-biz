export const SYSTEM_ROLES = [
  "owner",
  "manager",
  "supervisor",
  "cashier",
  "inventory_clerk",
  "accountant",
] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Never a tenant role: platform staff are outside tenant matrices. */
export const PLATFORM_ADMIN_ROLE = "platform_admin";
export const OWNER_ROLE: SystemRole = "owner";

const RESERVED = new Set<string>([PLATFORM_ADMIN_ROLE, "__proto__", "constructor", "prototype"]);
const ROLE_RE = /^[a-z][a-z0-9_]*$/;
const SYSTEM = new Set<string>(SYSTEM_ROLES);

export function isSystemRole(role: string): role is SystemRole {
  return SYSTEM.has(role);
}

/** System role or a custom tenant role name. */
export function isTenantRole(role: unknown): role is string {
  return typeof role === "string" && !RESERVED.has(role) && ROLE_RE.test(role);
}
