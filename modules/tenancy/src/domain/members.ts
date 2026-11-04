import { DomainError } from "@wise-biz/errors";
import { OWNER_ROLE } from "@wise-biz/policy";

/**
 * Owner rules for membership role changes.
 * - Only an owner may add or remove the owner role. A non-owner gets NOT_FOUND (unauthorized = 404 on admin surfaces).
 * - The tenant must always keep at least one active owner (CONFLICT when a change would remove the last one).
 */
export function assertOwnerRoleChange(input: {
  actorIsOwner: boolean;
  currentRoles: readonly string[];
  nextRoles: readonly string[];
}): void {
  const wasOwner = input.currentRoles.includes(OWNER_ROLE);
  const willBeOwner = input.nextRoles.includes(OWNER_ROLE);
  if (wasOwner !== willBeOwner && !input.actorIsOwner) {
    throw new DomainError("NOT_FOUND", "Not found");
  }
}

/**
 * Privilege ceiling for non-owners: they may only hand out roles they hold themselves, so `tenancy:manage` never
 * lifts anyone above the actor. Owners hold every tenant permission and are not limited. NOT_FOUND, not 403.
 */
export function assertAssignableRoles(input: {
  actorIsOwner: boolean;
  actorRoles: readonly string[];
  nextRoles: readonly string[];
}): void {
  if (input.actorIsOwner) return;
  const held = new Set(input.actorRoles);
  if (input.nextRoles.some((r) => !held.has(r))) throw new DomainError("NOT_FOUND", "Not found");
}

/** Only an owner may change anything (roles, branch scope) on a member who holds the owner role. */
export function assertOwnerTargetAccess(input: {
  actorIsOwner: boolean;
  targetRoles: readonly string[];
}): void {
  if (!input.actorIsOwner && input.targetRoles.includes(OWNER_ROLE)) {
    throw new DomainError("NOT_FOUND", "Not found");
  }
}

/**
 * Called with `otherActiveOwners` = active memberships other than the target that hold the owner role.
 * Removing the owner role from the target is allowed only when at least one other active owner remains.
 */
export function assertLastOwnerKept(input: {
  currentRoles: readonly string[];
  nextRoles: readonly string[];
  otherActiveOwners: number;
}): void {
  const wasOwner = input.currentRoles.includes(OWNER_ROLE);
  const willBeOwner = input.nextRoles.includes(OWNER_ROLE);
  if (wasOwner && !willBeOwner && input.otherActiveOwners < 1) {
    throw new DomainError("CONFLICT", "The tenant must keep at least one owner");
  }
}
