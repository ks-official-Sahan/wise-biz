/** Response shapes of the /v1 endpoints the console uses (mirrors packages/contracts/generated/openapi.json). */

export interface MyTenant {
  readonly tenantId: string;
  readonly name: string;
  readonly membershipId: string;
  readonly onboardedAt: string | null;
}

export interface Profile {
  readonly tenantId: string;
  readonly name: string;
  readonly country: string | null;
  readonly currency: string | null;
  readonly timezone: string | null;
  readonly taxRegion: string | null;
  readonly onboardedAt: string | null;
}

export type BranchKind = "store" | "warehouse" | "office";

export interface Branch {
  readonly branchId: string;
  readonly name: string;
  readonly kind: BranchKind;
  readonly timezone: string;
  readonly currency: string;
  readonly taxRegion: string;
  readonly businessDayCutoff: string;
  readonly archived: boolean;
}

export type LocationKind = "sales_floor" | "backroom" | "warehouse";

export interface Location {
  readonly locationId: string;
  readonly branchId: string;
  readonly name: string;
  readonly kind: LocationKind;
  readonly archived: boolean;
}

export interface Member {
  readonly membershipId: string;
  readonly userId: string;
  readonly status: "active" | "suspended";
  readonly roles: readonly string[];
  readonly branchIds: readonly string[] | null;
  readonly createdAt: string;
}

export interface Invite {
  readonly inviteId: string;
  readonly email: string;
  readonly roleIds: readonly string[];
  readonly branchIds: readonly string[] | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly expired: boolean;
}

export interface Grant {
  readonly permission: string;
  readonly conditions?: Record<string, unknown> | null;
}

export interface Role {
  readonly roleId: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly implicitAll: boolean;
  readonly grants: readonly Grant[];
}

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly action: string;
  readonly entity: { readonly type: string; readonly id: string | null };
  readonly requestId: string;
}

export interface AuditDetail extends AuditEntry {
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly chained: boolean;
}

export interface Page<K extends string, T> {
  readonly nextCursor: string | null;
  readonly items: Readonly<Record<K, readonly T[]>>;
}

export interface OnboardingDraft {
  readonly step: number;
  readonly values: Readonly<Record<string, unknown>>;
}
