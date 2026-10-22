import { DomainError } from "@wise-biz/errors";

import {
  assertAllFound,
  inviteExpiresAt,
  inviteStatus,
  normalizeEmail,
  uniqueIds,
} from "../domain/invites.ts";
import { assertAssignableRoles } from "../domain/members.ts";
import { TenantInviteRevokedV1, TenantMemberInvitedV1, TenantMemberJoinedV1 } from "../events.ts";

import { tenancyEvent } from "./envelope.ts";

import type { TenancyRepository, Tx } from "../ports/tenancy-repository.ts";
import type { InviteCreateInput } from "../schemas.ts";
import type { AuditDraft, CommandContext, CommandResult } from "@wise-biz/module-kit";

export interface InviteCreateActor {
  /** Owner-only rule: only an owner may invite with the owner role. */
  readonly isOwner: boolean;
  /** Role names the actor holds; a non-owner may only invite with these (privilege ceiling). */
  readonly roles: readonly string[];
}

/**
 * Create an invite. An expired pending invite for the same email is revoked IN THIS TRANSACTION first (storage keeps
 * expired invites pending until revoked); a live pending invite is a CONFLICT. Roles and branches must exist in the
 * tenant. The email is only ever stored normalised (trimmed, lower case).
 */
export async function createInviteCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  input: InviteCreateInput,
  actor: InviteCreateActor,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const email = normalizeEmail(input.email);
  const roleIds = uniqueIds(input.roleIds, "roleIds");
  const branchIds = input.branchIds == null ? null : uniqueIds(input.branchIds, "branchIds");

  const roles = await repo.findRoles(tx, tenantId, roleIds);
  assertAllFound(roleIds, new Set(roles.map((r) => r.id)), "roleIds");
  const ownerId = await repo.ownerRoleId(tx, tenantId);
  if (ownerId !== null && roleIds.includes(ownerId) && !actor.isOwner) {
    throw new DomainError("NOT_FOUND", "Not found");
  }
  assertAssignableRoles({
    actorIsOwner: actor.isOwner,
    actorRoles: actor.roles,
    nextRoles: roles.map((r) => r.name),
  });
  if (branchIds !== null) {
    assertAllFound(
      branchIds,
      new Set(await repo.findBranchIds(tx, tenantId, branchIds)),
      "branchIds",
    );
  }

  const audit: AuditDraft[] = [];
  const events = [];
  const pending = await repo.findPendingInviteByEmail(tx, tenantId, email);
  if (pending !== null) {
    if (inviteStatus(pending, ctx.now) === "pending") {
      throw new DomainError("CONFLICT", "a pending invite already exists for this email");
    }
    // Expired but still pending in storage: revoke it in this transaction, then insert the new invite.
    const revoked = await repo.revokeInvite(tx, tenantId, pending.inviteId, ctx.now);
    if (!revoked) throw new DomainError("CONFLICT", "invite changed while being replaced");
    audit.push({
      action: "tenancy.invite.revoked",
      entity: "tenancy.invite",
      entityId: pending.inviteId,
      reason: "expired before re-invite",
    });
    events.push(
      tenancyEvent(TenantInviteRevokedV1, ctx, `invite/${pending.inviteId}`, {
        inviteId: pending.inviteId,
        tenantId,
      }),
    );
  }

  const expiresAt = inviteExpiresAt(ctx.now);
  await repo.insertInvite(tx, tenantId, {
    inviteId: input.id,
    email,
    roleIds,
    branchIds,
    invitedBy: ctx.userId,
    expiresAt,
    createdAt: ctx.now,
  });
  const tenantName = await repo.tenantName(tx, tenantId);
  if (tenantName === null) throw new DomainError("INTERNAL", "tenant missing");

  const expiresIso = expiresAt.toISOString();
  events.push(
    tenancyEvent(TenantMemberInvitedV1, ctx, `invite/${input.id}`, {
      inviteId: input.id,
      tenantId,
      email,
      tenantName,
      expiresAt: expiresIso,
    }),
  );
  audit.push({
    action: "tenancy.invite.created",
    entity: "tenancy.invite",
    entityId: input.id,
    after: { roleIds, branchIds, expiresAt: expiresIso },
  });
  return {
    status: 201,
    body: { inviteId: input.id, email, roleIds, branchIds, expiresAt: expiresIso },
    audit,
    events,
  };
}

/** Revoke a pending invite (expired ones included). Accepted or already revoked: CONFLICT. Unknown: NOT_FOUND. */
export async function revokeInviteCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  inviteId: string,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const invite = await repo.findInvite(tx, tenantId, inviteId);
  if (invite === null) throw new DomainError("NOT_FOUND", "Not found");
  const status = inviteStatus(invite, ctx.now);
  if (status === "accepted" || status === "revoked") {
    throw new DomainError("CONFLICT", `invite is already ${status}`);
  }
  const ok = await repo.revokeInvite(tx, tenantId, inviteId, ctx.now);
  if (!ok) throw new DomainError("CONFLICT", "invite is no longer pending");
  return {
    status: 200,
    body: { inviteId, revokedAt: ctx.now.toISOString() },
    audit: [{ action: "tenancy.invite.revoked", entity: "tenancy.invite", entityId: inviteId }],
    events: [
      tenancyEvent(TenantInviteRevokedV1, ctx, `invite/${inviteId}`, { inviteId, tenantId }),
    ],
  };
}

export interface AcceptingUser {
  readonly email?: string | undefined;
  readonly emailVerified?: boolean | undefined;
}

/**
 * Accept an invite as the signed-in user. The caller has already verified the token (HMAC, constant time). Every
 * refusal about the invite or the account is NOT_FOUND, so a token holder learns nothing more; an existing membership
 * is CONFLICT. Runs in the INVITE's tenant (bootstrap transaction), so RLS applies as for any tenant write.
 */
export async function acceptInviteCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  inviteId: string,
  user: AcceptingUser,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const invite = await repo.findInvite(tx, tenantId, inviteId);
  if (invite === null) throw new DomainError("NOT_FOUND", "Not found");
  if (user.emailVerified !== true || user.email === undefined) {
    throw new DomainError("NOT_FOUND", "Not found");
  }
  if (normalizeEmail(user.email) !== invite.email) throw new DomainError("NOT_FOUND", "Not found");

  const existing = await repo.membershipForUser(tx, tenantId, ctx.userId);
  if (existing !== null) throw new DomainError("CONFLICT", "already a member of this business");
  if (inviteStatus(invite, ctx.now) !== "pending") throw new DomainError("NOT_FOUND", "Not found");

  const membershipId = ctx.ids.uuidv7();
  await repo.insertMembership(tx, {
    tenantId,
    id: membershipId,
    userId: ctx.userId,
    branchIds: invite.branchIds,
    createdAt: ctx.now,
  });
  await repo.insertMembershipRoles(tx, tenantId, membershipId, invite.roleIds);
  const marked = await repo.markInviteAccepted(tx, tenantId, inviteId, ctx.userId, ctx.now);
  if (!marked) throw new DomainError("CONFLICT", "invite was just used");

  return {
    status: 200,
    body: { tenantId, membershipId },
    audit: [
      {
        action: "tenancy.member.joined",
        entity: "tenancy.membership",
        entityId: membershipId,
        after: { inviteId, roleIds: invite.roleIds, branchIds: invite.branchIds },
      },
    ],
    events: [
      tenancyEvent(TenantMemberJoinedV1, ctx, `membership/${membershipId}`, {
        tenantId,
        membershipId,
        userId: ctx.userId,
        inviteId,
      }),
    ],
  };
}
