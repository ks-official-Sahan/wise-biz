import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/** Emitted in the same transaction as the tenant insert (outbox). */
export const TenantCreatedV1 = defineEvent(
  "tenancy.tenant.created",
  1,
  z.object({
    tenantId: z.string(),
    name: z.string(),
    branchId: z.string(),
    locationId: z.string(),
    ownerUserId: z.string(),
  }),
);

/** Carries the invitee's email: consumed by the invite-email consumer only; never logged. */
export const TenantMemberInvitedV1 = defineEvent(
  "tenancy.member.invited",
  1,
  z.object({
    inviteId: z.string(),
    tenantId: z.string(),
    email: z.string(),
    tenantName: z.string(),
    expiresAt: z.string(),
  }),
);

export const TenantInviteRevokedV1 = defineEvent(
  "tenancy.invite.revoked",
  1,
  z.object({ inviteId: z.string(), tenantId: z.string() }),
);

export const TenantMemberJoinedV1 = defineEvent(
  "tenancy.member.joined",
  1,
  z.object({
    tenantId: z.string(),
    membershipId: z.string(),
    userId: z.string(),
    inviteId: z.string(),
  }),
);

export const TenantMemberRolesChangedV1 = defineEvent(
  "tenancy.member.roles_changed",
  1,
  z.object({
    tenantId: z.string(),
    membershipId: z.string(),
    roleIds: z.array(z.string()),
    branchIds: z.array(z.string()).nullable(),
  }),
);

export const TenantRoleCreatedV1 = defineEvent(
  "tenancy.role.created",
  1,
  z.object({ tenantId: z.string(), roleId: z.string(), name: z.string() }),
);

export const TenantRolePermissionsChangedV1 = defineEvent(
  "tenancy.role.permissions_changed",
  1,
  z.object({
    tenantId: z.string(),
    roleId: z.string(),
    permissions: z.array(z.string()),
  }),
);

/** `changed` lists the profile fields that changed; values are in the payload (no PII in a business profile). */
export const TenantProfileUpdatedV1 = defineEvent(
  "tenancy.business.updated",
  1,
  z.object({
    tenantId: z.string(),
    changed: z.array(z.string()),
    name: z.string(),
    country: z.string().nullable(),
    currency: z.string().nullable(),
    timezone: z.string().nullable(),
    taxRegion: z.string().nullable(),
  }),
);

export const TenantOnboardedV1 = defineEvent(
  "tenancy.business.onboarded",
  1,
  z.object({ tenantId: z.string(), onboardedAt: z.string() }),
);

const BranchData = z.object({
  tenantId: z.string(),
  branchId: z.string(),
  name: z.string(),
  kind: z.string(),
  timezone: z.string(),
  currency: z.string(),
  taxRegion: z.string(),
  businessDayCutoff: z.string(),
  archived: z.boolean(),
});

export const TenantBranchCreatedV1 = defineEvent("tenancy.branch.created", 1, BranchData);
export const TenantBranchUpdatedV1 = defineEvent("tenancy.branch.updated", 1, BranchData);

const LocationData = z.object({
  tenantId: z.string(),
  locationId: z.string(),
  branchId: z.string(),
  name: z.string(),
  kind: z.string(),
  archived: z.boolean(),
});

export const TenantLocationCreatedV1 = defineEvent("tenancy.location.created", 1, LocationData);
export const TenantLocationUpdatedV1 = defineEvent("tenancy.location.updated", 1, LocationData);

export const TENANCY_EVENTS = [
  TenantCreatedV1,
  TenantMemberInvitedV1,
  TenantInviteRevokedV1,
  TenantMemberJoinedV1,
  TenantMemberRolesChangedV1,
  TenantRoleCreatedV1,
  TenantRolePermissionsChangedV1,
  TenantProfileUpdatedV1,
  TenantOnboardedV1,
  TenantBranchCreatedV1,
  TenantBranchUpdatedV1,
  TenantLocationCreatedV1,
  TenantLocationUpdatedV1,
] as const;

export const TENANCY_TENANT_TOPIC = "tenancy.tenant";
