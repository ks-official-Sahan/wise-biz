import { DomainError } from "@wise-biz/errors";
import { isCurrency } from "@wise-biz/money";
import { SYSTEM_ROLES } from "@wise-biz/policy";

import type { Permission, SystemRole } from "@wise-biz/policy";

export const NAME_MAX = 200;
export const BRANCH_KINDS = ["store", "warehouse", "office"] as const;
export type BranchKind = (typeof BRANCH_KINDS)[number];

export const DEFAULT_LOCATION_NAME = "Main";
export const CUTOFF_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Grants every new tenant starts with. Owner is implicit (matrixFromRows grants it everything), so it has no rows.
 * Modules add their own default grants when they land; tenants edit roles afterwards.
 */
export const DEFAULT_ROLE_GRANTS: Readonly<Record<SystemRole, readonly Permission[]>> = {
  owner: [],
  manager: ["tenancy:read", "devices:read", "devices:manage", "devices:pin", "devices:unlock"],
  supervisor: ["tenancy:read", "devices:read", "devices:pin", "devices:unlock"],
  cashier: ["devices:pin"],
  inventory_clerk: ["devices:pin"],
  accountant: ["tenancy:read"],
};

export interface NewBusinessInput {
  readonly tenantId: string;
  readonly name: string;
  readonly branch: {
    readonly name: string;
    readonly kind: string;
    readonly timezone: string;
    readonly currency: string;
    readonly taxRegion: string;
    readonly businessDayCutoff?: string | undefined;
  };
}

/** Injected, so the rule stays pure and testable. */
export interface NewBusinessDeps {
  readonly ownerUserId: string;
  readonly nextId: () => string;
  readonly now: Date;
}

export interface BusinessRows {
  readonly tenant: { tenantId: string; name: string; createdAt: Date };
  readonly roles: readonly { id: string; name: SystemRole }[];
  readonly rolePermissions: readonly { id: string; roleId: string; permission: Permission }[];
  readonly branch: {
    id: string;
    name: string;
    kind: BranchKind;
    timezone: string;
    currency: string;
    taxRegion: string;
    businessDayCutoff: string;
  };
  readonly location: { id: string; branchId: string; name: string };
  readonly membership: { id: string; userId: string };
  readonly ownerRoleId: string;
  readonly createdAt: Date;
}

export function fail(path: string, message: string): never {
  throw new DomainError("VALIDATION_FAILED", `${path}: ${message}`, {
    fieldErrors: [{ path, message }],
  });
}

export function text(path: string, raw: string, max: number): string {
  const v = raw.trim();
  if (v.length < 1 || v.length > max)
    fail(path, `must be 1-${String(max)} characters after trimming`);
  return v;
}

/** IANA zone check via Intl (throws RangeError for an unknown zone). */
export function isIanaTimezone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Pure: validates and builds every row of a new business. No IO, no clock, no id generator of its own. */
export function newBusiness(input: NewBusinessInput, deps: NewBusinessDeps): BusinessRows {
  const b = input.branch;
  if (!(BRANCH_KINDS as readonly string[]).includes(b.kind)) fail("branch.kind", "unknown kind");
  if (!isIanaTimezone(b.timezone)) fail("branch.timezone", "must be an IANA time zone");
  if (!isCurrency(b.currency)) fail("branch.currency", "must be an ISO 4217 currency");
  const cutoff = b.businessDayCutoff ?? "00:00";
  if (!CUTOFF_RE.test(cutoff)) fail("branch.businessDayCutoff", "must be HH:MM");

  const roles = SYSTEM_ROLES.map((name) => ({ id: deps.nextId(), name }));
  const roleId = new Map(roles.map((r) => [r.name, r.id]));
  const ownerRoleId = roleId.get("owner");
  if (ownerRoleId === undefined) throw new DomainError("INTERNAL", "owner role missing");
  const branchId = deps.nextId();

  return {
    tenant: {
      tenantId: input.tenantId,
      name: text("name", input.name, NAME_MAX),
      createdAt: deps.now,
    },
    roles,
    rolePermissions: SYSTEM_ROLES.flatMap((role) =>
      DEFAULT_ROLE_GRANTS[role].map((permission) => ({
        id: deps.nextId(),
        roleId: roleId.get(role) ?? ownerRoleId,
        permission,
      })),
    ),
    branch: {
      id: branchId,
      name: text("branch.name", b.name, NAME_MAX),
      kind: b.kind as BranchKind,
      timezone: b.timezone,
      currency: b.currency,
      taxRegion: text("branch.taxRegion", b.taxRegion, 32),
      businessDayCutoff: cutoff,
    },
    location: { id: deps.nextId(), branchId, name: DEFAULT_LOCATION_NAME },
    membership: { id: deps.nextId(), userId: deps.ownerUserId },
    ownerRoleId,
    createdAt: deps.now,
  };
}
