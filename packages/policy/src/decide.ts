import {
  firstFailure,
  type ConditionReason,
  type DecisionContext,
  type Resource,
} from "./conditions.ts";
import { isPlatformPermission, type Permission } from "./permissions.ts";

import type { Grant, PolicyMatrix } from "./matrix.ts";

export type Reason = "tenant_mismatch" | "branch_out_of_scope" | "not_granted" | ConditionReason;

export type Override = Readonly<{ permission: Permission; approverRoles: readonly string[] }>;

export type Decision =
  | Readonly<{ allow: true; reason: "granted"; grant: Grant }>
  | Readonly<{ allow: false; reason: Reason; override?: Override }>;

const deny = (reason: Reason): Decision => ({ allow: false, reason });

/**
 * Pure and deterministic. Order: tenant, branch scope, grants, conditions.
 * Most permissive grant wins. A condition denial carries `override` listing the other roles
 * (sorted, never ctx.roles) that would pass for this exact context and resource.
 */
export function decide(
  matrix: PolicyMatrix,
  ctx: DecisionContext,
  permission: Permission,
  resource: Resource,
): Decision {
  if (ctx.tenantId !== resource.tenantId) return deny("tenant_mismatch");
  if (
    resource.branchId !== undefined &&
    ctx.branchScope !== "all" &&
    !ctx.branchScope.includes(resource.branchId)
  ) {
    return deny("branch_out_of_scope");
  }
  // Platform permissions are never decidable inside a tenant, whatever a matrix claims.
  if (isPlatformPermission(permission)) return deny("not_granted");

  let failure: Reason | undefined;
  for (const role of ctx.roles) {
    for (const grant of matrix[role] ?? []) {
      if (grant.permission !== permission) continue;
      const failed = firstFailure(grant.conditions, ctx, resource);
      if (failed === undefined) return { allow: true, reason: "granted", grant };
      failure ??= failed;
    }
  }
  if (failure === undefined) return deny("not_granted");

  const own = new Set(ctx.roles);
  const approverRoles = Object.entries(matrix)
    .filter(
      ([role, grants]) =>
        !own.has(role) &&
        grants.some(
          (g) =>
            g.permission === permission && firstFailure(g.conditions, ctx, resource) === undefined,
        ),
    )
    .map(([role]) => role)
    .sort();
  return approverRoles.length === 0
    ? deny(failure)
    : { allow: false, reason: failure, override: { permission, approverRoles } };
}
