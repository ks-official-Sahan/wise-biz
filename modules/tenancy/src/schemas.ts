import { Uuid7 } from "@wise-biz/contracts";
import { z } from "zod";

import { BRANCH_KINDS, isIanaTimezone } from "./domain/business.ts";
import { LOCATION_KINDS } from "./domain/profile.ts";

/** Shape only; the domain trims and enforces the business rules again (defence in depth). */
export const SignUpBusinessSchema = z
  .object({
    tenantId: Uuid7,
    name: z.string().max(1000),
    branch: z.object({
      name: z.string().max(1000),
      kind: z.enum(BRANCH_KINDS),
      timezone: z.string().max(64).refine(isIanaTimezone, "must be an IANA time zone"),
      currency: z.string().max(3),
      taxRegion: z.string().max(100),
      businessDayCutoff: z.string().max(5).optional(),
    }),
  })
  .meta({ id: "TenancySignUpBusiness" });

export const TenantCreatedSchema = z
  .object({ tenantId: Uuid7, name: z.string(), branchId: Uuid7, locationId: Uuid7 })
  .meta({ id: "TenancyTenantCreated" });

export const MyTenantSchema = z
  .object({
    tenantId: Uuid7,
    name: z.string(),
    membershipId: Uuid7,
    /** null until the owner finishes onboarding; the console routes there first. */
    onboardedAt: z.string().nullable(),
  })
  .meta({ id: "TenancyMyTenant" });

export const MyTenantsSchema = z
  .object({ tenants: z.array(MyTenantSchema) })
  .meta({ id: "TenancyMyTenants" });

export const SwitchTenantSchema = z.object({ tenantId: Uuid7 }).meta({ id: "TenancySwitchTenant" });

// Response schemas use plain strings for ids: handlers return database text, and the request schemas above already
// enforce UUIDv7 on everything the client sends.
const Id = z.string().min(1);
const NullableIds = z.array(Id).nullable();

/** Email is normalised (trim + lower case) by the domain before it is stored. */
export const InviteCreateSchema = z
  .object({
    id: Uuid7,
    email: z.string().trim().max(320).pipe(z.email()),
    roleIds: z.array(Uuid7).min(1).max(20),
    /** Omitted or null = every branch of the tenant. */
    branchIds: z.array(Uuid7).min(1).max(50).nullable().optional(),
  })
  .meta({ id: "TenancyInviteCreate" });

export const InviteSchema = z
  .object({
    inviteId: Id,
    email: z.string(),
    roleIds: z.array(Id),
    branchIds: NullableIds,
    expiresAt: z.string(),
    createdAt: z.string(),
    expired: z.boolean(),
  })
  .meta({ id: "TenancyInvite" });

export const InviteListSchema = z
  .object({ invites: z.array(InviteSchema), nextCursor: Id.nullable() })
  .meta({ id: "TenancyInviteList" });

export const InviteCreatedSchema = z
  .object({
    inviteId: Id,
    email: z.string(),
    roleIds: z.array(Id),
    branchIds: NullableIds,
    expiresAt: z.string(),
  })
  .meta({ id: "TenancyInviteCreated" });

/** Empty object body: the idempotency machinery needs a JSON body on every mutation. */
export const EmptyBodySchema = z.object({}).meta({ id: "TenancyEmptyBody" });

export const InviteRevokedSchema = z
  .object({ inviteId: Id, revokedAt: z.string() })
  .meta({ id: "TenancyInviteRevoked" });

export const InviteAcceptSchema = z
  .object({
    tenantId: Uuid7,
    inviteId: Uuid7,
    token: z.string().min(1).max(128),
  })
  .meta({ id: "TenancyInviteAccept" });

export const InviteAcceptedSchema = z
  .object({ tenantId: Id, membershipId: Id })
  .meta({ id: "TenancyInviteAccepted" });

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: Uuid7.optional(),
});

export const IdParamSchema = z.object({ id: Uuid7 });

export const MemberSchema = z
  .object({
    membershipId: Id,
    userId: Id,
    status: z.enum(["active", "suspended"]),
    roles: z.array(z.string()),
    branchIds: NullableIds,
    createdAt: z.string(),
  })
  .meta({ id: "TenancyMember" });

export const MemberListSchema = z
  .object({ members: z.array(MemberSchema), nextCursor: Id.nullable() })
  .meta({ id: "TenancyMemberList" });

/** branchIds omitted = keep the current scope; null = all branches; array = exactly these branches. */
export const MemberRolesUpdateSchema = z
  .object({
    roleIds: z.array(Uuid7).min(1).max(20),
    branchIds: z.array(Uuid7).min(1).max(50).nullable().optional(),
  })
  .meta({ id: "TenancyMemberRolesUpdate" });

export const MemberRolesUpdatedSchema = z
  .object({ membershipId: Id, roleIds: z.array(Id), branchIds: NullableIds })
  .meta({ id: "TenancyMemberRolesUpdated" });

export const GrantSchema = z
  .object({
    permission: z.string(),
    conditions: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .meta({ id: "TenancyGrant" });

export const RoleSchema = z
  .object({
    roleId: Id,
    name: z.string(),
    isSystem: z.boolean(),
    /** True for the owner role: it holds every tenant permission implicitly and is immutable. */
    implicitAll: z.boolean(),
    grants: z.array(GrantSchema),
  })
  .meta({ id: "TenancyRole" });

export const RoleListSchema = z
  .object({ roles: z.array(RoleSchema) })
  .meta({ id: "TenancyRoleList" });

export const RoleCreateSchema = z
  .object({ id: Uuid7, name: z.string().min(1).max(63) })
  .meta({ id: "TenancyRoleCreate" });

export const RolePermissionsSchema = z
  .object({ grants: z.array(GrantSchema).max(200) })
  .meta({ id: "TenancyRolePermissions" });

export const BranchSchema = z
  .object({
    branchId: Id,
    name: z.string(),
    kind: z.enum(BRANCH_KINDS),
    timezone: z.string(),
    currency: z.string(),
    taxRegion: z.string(),
    businessDayCutoff: z.string(),
    archived: z.boolean(),
  })
  .meta({ id: "TenancyBranch" });

export const BranchListSchema = z
  .object({ branches: z.array(BranchSchema) })
  .meta({ id: "TenancyBranchList" });

const Short = z.string().max(1000);

export const BranchCreateSchema = z
  .object({
    id: Uuid7,
    name: Short,
    kind: z.enum(BRANCH_KINDS),
    timezone: z.string().max(64),
    currency: z.string().max(3),
    taxRegion: z.string().max(100),
    businessDayCutoff: z.string().max(5).optional(),
  })
  .meta({ id: "TenancyBranchCreate" });

/** Only the fields present change; `archived: true` archives (never deletes), `false` restores. */
export const BranchUpdateSchema = z
  .object({
    name: Short.optional(),
    kind: z.enum(BRANCH_KINDS).optional(),
    timezone: z.string().max(64).optional(),
    currency: z.string().max(3).optional(),
    taxRegion: z.string().max(100).optional(),
    businessDayCutoff: z.string().max(5).optional(),
    archived: z.boolean().optional(),
  })
  .meta({ id: "TenancyBranchUpdate" });

export const ProfileSchema = z
  .object({
    tenantId: Id,
    name: z.string(),
    country: z.string().nullable(),
    currency: z.string().nullable(),
    timezone: z.string().nullable(),
    taxRegion: z.string().nullable(),
    onboardedAt: z.string().nullable(),
  })
  .meta({ id: "TenancyBusinessProfile" });

export const ProfileUpdateSchema = z
  .object({
    name: Short.optional(),
    country: z.string().max(2).nullable().optional(),
    currency: z.string().max(3).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
    taxRegion: z.string().max(100).nullable().optional(),
  })
  .meta({ id: "TenancyBusinessProfileUpdate" });

export const LocationSchema = z
  .object({
    locationId: Id,
    branchId: Id,
    name: z.string(),
    kind: z.enum(LOCATION_KINDS),
    archived: z.boolean(),
  })
  .meta({ id: "TenancyLocation" });

export const LocationListSchema = z
  .object({ locations: z.array(LocationSchema) })
  .meta({ id: "TenancyLocationList" });

export const LocationCreateSchema = z
  .object({ id: Uuid7, name: Short, kind: z.enum(LOCATION_KINDS).optional() })
  .meta({ id: "TenancyLocationCreate" });

export const LocationUpdateSchema = z
  .object({
    name: Short.optional(),
    kind: z.enum(LOCATION_KINDS).optional(),
    archived: z.boolean().optional(),
  })
  .meta({ id: "TenancyLocationUpdate" });

/**
 * The wizard's autosaved draft. Loose on purpose (a half-filled form), bounded in size; nothing in it takes effect
 * until the console calls the real endpoints and then `onboarding/complete`.
 */
export const OnboardingDraftSchema = z
  .object({
    step: z.number().int().min(0).max(20),
    values: z
      .record(z.string().max(64), z.unknown())
      .refine((v) => JSON.stringify(v).length <= 16_384, "draft is too large"),
  })
  .meta({ id: "TenancyOnboardingDraft" });

export const OnboardingSchema = z
  .object({
    onboardedAt: z.string().nullable(),
    draft: OnboardingDraftSchema.nullable(),
  })
  .meta({ id: "TenancyOnboarding" });

export const LocationParamSchema = z.object({ id: Uuid7 });

export const OnboardingDraftSavedSchema = z
  .object({ saved: z.literal(true), step: z.number().int() })
  .meta({ id: "TenancyOnboardingDraftSaved" });

export const OnboardingCompletedSchema = z
  .object({ onboardedAt: z.string() })
  .meta({ id: "TenancyOnboardingCompleted" });

export type InviteCreateInput = z.infer<typeof InviteCreateSchema>;
export type InviteAcceptInput = z.infer<typeof InviteAcceptSchema>;
export type MemberRolesUpdateInput = z.infer<typeof MemberRolesUpdateSchema>;
export type RoleCreateInput = z.infer<typeof RoleCreateSchema>;
export type RolePermissionsInput = z.infer<typeof RolePermissionsSchema>;
export type SignUpBusinessInput = z.infer<typeof SignUpBusinessSchema>;
export type BranchCreateInput = z.infer<typeof BranchCreateSchema>;
export type BranchUpdateInput = z.infer<typeof BranchUpdateSchema>;
export type ProfileUpdateInput = z.infer<typeof ProfileUpdateSchema>;
export type LocationCreateInput = z.infer<typeof LocationCreateSchema>;
export type LocationUpdateInput = z.infer<typeof LocationUpdateSchema>;
export type OnboardingDraft = z.infer<typeof OnboardingDraftSchema>;
export type TenantCreatedDto = z.infer<typeof TenantCreatedSchema>;
export type MyTenantDto = z.infer<typeof MyTenantSchema>;
