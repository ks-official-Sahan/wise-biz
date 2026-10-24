import { DomainError } from "@wise-biz/errors";
import { OWNER_ROLE } from "@wise-biz/policy";

import { assertAllFound, uniqueIds } from "../domain/invites.ts";
import {
  assertAssignableRoles,
  assertLastOwnerKept,
  assertOwnerRoleChange,
  assertOwnerTargetAccess,
} from "../domain/members.ts";
import { TenantMemberRolesChangedV1 } from "../events.ts";

import { tenancyEvent } from "./envelope.ts";

import type { TenancyRepository, Tx } from "../ports/tenancy-repository.ts";
import type { MemberRolesUpdateInput } from "../schemas.ts";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";

export interface MemberRolesActor {
  readonly isOwner: boolean;
  /** Role names the actor holds in this tenant (privilege ceiling for non-owners). */
  readonly roles: readonly string[];
}

/**
 * Replace a member's roles (and branch scope when `branchIds` is given). Rules, in order:
 *  1. the target exists in the tenant (NOT_FOUND otherwise);
 *  2. roles and branches exist in the tenant (VALIDATION_FAILED);
 *  3. a non-owner may not touch an owner member, nor hand out a role they do not hold (NOT_FOUND);
 *  4. only an owner may add or remove the owner role (NOT_FOUND for others);
 *  5. the last active owner cannot be demoted (CONFLICT).
 * Membership changes take a per-tenant advisory lock, so two concurrent demotions cannot both pass rule 4.
 */
export async function updateMemberRolesCommand(
  repo: TenancyRepository,
  tx: Tx,
  ctx: CommandContext,
  membershipId: string,
  input: MemberRolesUpdateInput,
  actor: MemberRolesActor,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  await repo.lockMembershipChanges(tx, tenantId);

  const target = await repo.loadMember(tx, tenantId, membershipId);
  if (target === null) throw new DomainError("NOT_FOUND", "Not found");
  assertOwnerTargetAccess({ actorIsOwner: actor.isOwner, targetRoles: target.roles });

  const roleIds = uniqueIds(input.roleIds, "roleIds");
  const roles = await repo.findRoles(tx, tenantId, roleIds);
  assertAllFound(roleIds, new Set(roles.map((r) => r.id)), "roleIds");
  const nextRoles = roles.map((r) => r.name);
  assertAssignableRoles({ actorIsOwner: actor.isOwner, actorRoles: actor.roles, nextRoles });

  let branchIds = target.branchIds;
  if (input.branchIds !== undefined) {
    branchIds = input.branchIds === null ? null : uniqueIds(input.branchIds, "branchIds");
    if (branchIds !== null) {
      assertAllFound(
        branchIds,
        new Set(await repo.findBranchIds(tx, tenantId, branchIds)),
        "branchIds",
      );
    }
  }

  assertOwnerRoleChange({ actorIsOwner: actor.isOwner, currentRoles: target.roles, nextRoles });
  const ownerId = await repo.ownerRoleId(tx, tenantId);
  const otherActiveOwners =
    ownerId === null || !target.roles.includes(OWNER_ROLE)
      ? 0
      : await repo.countOtherActiveOwners(tx, tenantId, ownerId, membershipId);
  assertLastOwnerKept({ currentRoles: target.roles, nextRoles, otherActiveOwners });

  await repo.replaceMembershipRoles(tx, tenantId, membershipId, roleIds);
  if (input.branchIds !== undefined) {
    await repo.setMembershipBranches(tx, tenantId, membershipId, branchIds);
  }
  return {
    status: 200,
    body: { membershipId, roleIds, branchIds },
    audit: [
      {
        action: "tenancy.member.roles_changed",
        entity: "tenancy.membership",
        entityId: membershipId,
        before: { roles: target.roles, branchIds: target.branchIds },
        after: { roleIds, branchIds },
      },
    ],
    events: [
      tenancyEvent(TenantMemberRolesChangedV1, ctx, `membership/${membershipId}`, {
        tenantId,
        membershipId,
        roleIds,
        branchIds,
      }),
    ],
  };
}
