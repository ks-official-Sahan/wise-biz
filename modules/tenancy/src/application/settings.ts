import { DomainError } from "@wise-biz/errors";

import {
  normaliseBranch,
  normaliseLocation,
  normaliseProfilePatch,
  profileComplete,
} from "../domain/profile.ts";
import {
  TenantBranchCreatedV1,
  TenantBranchUpdatedV1,
  TenantLocationCreatedV1,
  TenantLocationUpdatedV1,
  TenantOnboardedV1,
  TenantProfileUpdatedV1,
} from "../events.ts";

import { tenancyEvent } from "./envelope.ts";

import type {
  BranchRow,
  LocationRow,
  ProfileRow,
  TenancyRepository,
  Tx,
} from "../ports/tenancy-repository.ts";
import type {
  BranchCreateInput,
  BranchUpdateInput,
  LocationCreateInput,
  LocationUpdateInput,
  OnboardingDraft,
  ProfileUpdateInput,
} from "../schemas.ts";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";

/** tenancy.settings key of the onboarding wizard draft. */
export const ONBOARDING_DRAFT_KEY = "onboarding.draft";

const notFound = (): never => {
  throw new DomainError("NOT_FOUND", "Not found");
};

export function toProfileDto(p: ProfileRow) {
  return {
    tenantId: p.tenantId,
    name: p.name,
    country: p.country,
    currency: p.currency,
    timezone: p.timezone,
    taxRegion: p.taxRegion,
    onboardedAt: p.onboardedAt?.toISOString() ?? null,
  };
}

export function toLocationDto(l: LocationRow) {
  return {
    locationId: l.locationId,
    branchId: l.branchId,
    name: l.name,
    kind: l.kind,
    archived: l.archived,
  };
}

/** Business profile patch. Audit keeps before and after of the changed fields only. */
export async function updateProfileCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  input: ProfileUpdateInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const patch = normaliseProfilePatch(input);
  const before = (await repo.loadProfile(tx, tenantId)) ?? notFound();
  const after = await repo.updateProfile(tx, tenantId, patch);
  const changed = Object.keys(patch).sort();
  const pick = (p: ProfileRow) =>
    Object.fromEntries(changed.map((k) => [k, p[k as keyof ProfileRow] ?? null]));
  return {
    status: 200,
    body: toProfileDto(after),
    audit: [
      {
        action: "tenancy.business.updated",
        entity: "tenancy.tenant",
        entityId: tenantId,
        before: pick(before),
        after: pick(after),
      },
    ],
    events: [
      tenancyEvent(TenantProfileUpdatedV1, ctx, `tenant/${tenantId}`, {
        tenantId,
        changed,
        name: after.name,
        country: after.country,
        currency: after.currency,
        timezone: after.timezone,
        taxRegion: after.taxRegion,
      }),
    ],
  };
}

/** Saves the wizard draft. Audited (rule 5) but silent on the bus: nothing in a draft takes effect. */
export async function saveOnboardingDraftCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  draft: OnboardingDraft,
  actor: { isOwner: boolean },
): Promise<CommandResult> {
  if (!actor.isOwner) notFound();
  const tenantId = ctx.tenant.tenantId;
  await repo.putSetting(tx, tenantId, ONBOARDING_DRAFT_KEY, draft, ctx.now);
  return {
    status: 200,
    body: { saved: true, step: draft.step },
    audit: [
      {
        action: "tenancy.onboarding.draft_saved",
        entity: "tenancy.tenant",
        entityId: tenantId,
        after: { step: draft.step },
      },
    ],
    noEvents: true,
  };
}

/**
 * Finishes onboarding: the profile must be complete (country, currency, time zone, tax region). Idempotent: a second
 * call on an onboarded business returns the stored timestamp and emits no event; its audit row (rule 5) records that
 * it was already done.
 */
export async function completeOnboardingCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  actor: { isOwner: boolean },
): Promise<CommandResult> {
  if (!actor.isOwner) notFound();
  const tenantId = ctx.tenant.tenantId;
  const profile = (await repo.loadProfile(tx, tenantId)) ?? notFound();
  if (!profileComplete(profile)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "profile: country, currency, timezone and taxRegion are required",
      {
        fieldErrors: [{ path: "profile", message: "complete the business profile first" }],
      },
    );
  }
  const first = await repo.markOnboarded(tx, tenantId, ctx.now);
  const onboardedAt = first ? ctx.now : (profile.onboardedAt ?? ctx.now);
  return {
    status: 200,
    body: { onboardedAt: onboardedAt.toISOString() },
    audit: [
      {
        action: first ? "tenancy.business.onboarded" : "tenancy.business.onboarded_again",
        entity: "tenancy.tenant",
        entityId: tenantId,
        after: { onboardedAt: onboardedAt.toISOString() },
      },
    ],
    ...(first
      ? {
          events: [
            tenancyEvent(TenantOnboardedV1, ctx, `tenant/${tenantId}`, {
              tenantId,
              onboardedAt: onboardedAt.toISOString(),
            }),
          ],
        }
      : { noEvents: true }),
  };
}

function branchEventData(tenantId: string, b: BranchRow) {
  return { tenantId, ...b };
}

export async function createBranchCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  input: BranchCreateInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { id, ...fields } = input;
  const v = normaliseBranch(fields, "create") as Required<ReturnType<typeof normaliseBranch>>;
  await repo.insertBranch(tx, { tenantId, branchId: id, ...v, createdAt: ctx.now });
  const row: BranchRow = { branchId: id, ...v, archived: false };
  return {
    status: 201,
    body: row,
    audit: [
      { action: "tenancy.branch.created", entity: "tenancy.branch", entityId: id, after: row },
    ],
    events: [
      tenancyEvent(TenantBranchCreatedV1, ctx, `branch/${id}`, branchEventData(tenantId, row)),
    ],
  };
}

export async function updateBranchCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  branchId: string,
  input: BranchUpdateInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { archived, ...fields } = input;
  const hasFields = Object.values(fields).some((v) => v !== undefined);
  const v = hasFields ? normaliseBranch(fields, "patch") : {};
  if (!hasFields && archived === undefined) {
    throw new DomainError("VALIDATION_FAILED", "body: nothing to change", {
      fieldErrors: [{ path: "body", message: "nothing to change" }],
    });
  }
  const before = (await repo.findBranch(tx, tenantId, branchId)) ?? notFound();
  const archivedAt = archived === undefined ? undefined : archived ? ctx.now : null;
  const after =
    (await repo.updateBranch(tx, tenantId, branchId, {
      ...v,
      ...(archivedAt === undefined ? {} : { archivedAt }),
    })) ?? notFound();
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "tenancy.branch.updated",
        entity: "tenancy.branch",
        entityId: branchId,
        before,
        after,
      },
    ],
    events: [
      tenancyEvent(
        TenantBranchUpdatedV1,
        ctx,
        `branch/${branchId}`,
        branchEventData(tenantId, after),
      ),
    ],
  };
}

export async function createLocationCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  branchId: string,
  input: LocationCreateInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const branch = (await repo.findBranch(tx, tenantId, branchId)) ?? notFound();
  if (branch.archived) throw new DomainError("CONFLICT", "branch is archived");
  const v = normaliseLocation(input, "create") as { name: string; kind: string };
  await repo.insertLocation(tx, {
    tenantId,
    locationId: input.id,
    branchId,
    name: v.name,
    kind: v.kind,
    createdAt: ctx.now,
  });
  const row: LocationRow = {
    locationId: input.id,
    branchId,
    name: v.name,
    kind: v.kind,
    archived: false,
  };
  return {
    status: 201,
    body: toLocationDto(row),
    audit: [
      {
        action: "tenancy.location.created",
        entity: "tenancy.location",
        entityId: input.id,
        after: row,
      },
    ],
    events: [
      tenancyEvent(TenantLocationCreatedV1, ctx, `location/${input.id}`, { tenantId, ...row }),
    ],
  };
}

export async function updateLocationCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  locationId: string,
  input: LocationUpdateInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { archived, ...fields } = input;
  const hasFields = fields.name !== undefined || fields.kind !== undefined;
  if (!hasFields && archived === undefined) {
    throw new DomainError("VALIDATION_FAILED", "body: nothing to change", {
      fieldErrors: [{ path: "body", message: "nothing to change" }],
    });
  }
  const v = hasFields ? normaliseLocation(fields, "patch") : {};
  const archivedAt = archived === undefined ? undefined : archived ? ctx.now : null;
  const after =
    (await repo.updateLocation(tx, tenantId, locationId, {
      ...v,
      ...(archivedAt === undefined ? {} : { archivedAt }),
    })) ?? notFound();
  return {
    status: 200,
    body: toLocationDto(after),
    audit: [
      {
        action: "tenancy.location.updated",
        entity: "tenancy.location",
        entityId: locationId,
        after,
      },
    ],
    events: [
      tenancyEvent(TenantLocationUpdatedV1, ctx, `location/${locationId}`, { tenantId, ...after }),
    ],
  };
}
