import {
  firstFailure,
  type ConditionReason,
  type DecisionContext,
  type Resource,
} from "./conditions.ts";
import { freezeGrant } from "./matrix.ts";
import { isPlatformPermission, type Permission } from "./permissions.ts";

import type { Grant, PolicyMatrix } from "./matrix.ts";

export type Reason =
  "tenant_mismatch" | "invalid_context" | "branch_out_of_scope" | "not_granted" | ConditionReason;

export type Override = Readonly<{ permission: Permission; approverRoles: readonly string[] }>;

export type Decision =
  | Readonly<{ allow: true; reason: "granted"; grant: Grant }>
  | Readonly<{ allow: false; reason: Reason; override?: Override }>;

const deny = (reason: Reason): Decision => ({ allow: false, reason });

type Index = ReadonlyMap<string, ReadonlyMap<string, readonly Grant[]>>;
const indexes = new WeakMap<object, Index>();

function buildIndex(matrix: PolicyMatrix): Index {
  const idx = new Map<string, Map<string, Grant[]>>();
  for (const role of Object.keys(matrix)) {
    const byPerm = new Map<string, Grant[]>();
    for (const g of matrix[role] ?? []) {
      const list = byPerm.get(g.permission);
      if (list === undefined) byPerm.set(g.permission, [g]);
      else list.push(g);
    }
    idx.set(role, byPerm);
  }
  return idx;
}

/** Frozen matrices are immutable, so their index is cached; others are indexed per call. */
function indexOf(matrix: PolicyMatrix): Index {
  if (!Object.isFrozen(matrix)) return buildIndex(matrix);
  let idx = indexes.get(matrix);
  if (idx === undefined) indexes.set(matrix, (idx = buildIndex(matrix)));
  return idx;
}

const isId = (v: unknown): v is string => typeof v === "string" && v !== "";
const validTime = (c: DecisionContext): boolean =>
  Number.isInteger(c.localMinuteOfDay) &&
  c.localMinuteOfDay >= 0 &&
  c.localMinuteOfDay <= 1439 &&
  Number.isInteger(c.localDayOfWeek) &&
  c.localDayOfWeek >= 0 &&
  c.localDayOfWeek <= 6;

/**
 * Pure and deterministic. Order: tenant, context, branch scope, grants, conditions.
 * Fails closed: empty tenant ids, bad time context, and a branch-scoped user acting on a
 * resource with no branchId are all denied. Most permissive grant wins. A condition denial
 * carries `override` listing the other roles (sorted, never ctx.roles) that would pass for this
 * exact context and resource. Approvers share the requesting device/time context because
 * overrides are a supervisor PIN on the same terminal.
 */
export function decide(
  matrix: PolicyMatrix,
  ctx: DecisionContext,
  permission: Permission,
  resource: Resource,
): Decision {
  if (!isId(ctx.tenantId) || !isId(resource.tenantId) || ctx.tenantId !== resource.tenantId) {
    return deny("tenant_mismatch");
  }
  if (!validTime(ctx)) return deny("invalid_context");
  if (
    ctx.branchScope !== "all" &&
    (resource.branchId === undefined || !ctx.branchScope.includes(resource.branchId))
  ) {
    return deny("branch_out_of_scope");
  }
  // Platform permissions are never decidable inside a tenant, whatever a matrix claims.
  if (isPlatformPermission(permission)) return deny("not_granted");

  const idx = indexOf(matrix);
  let failure: Reason | undefined;
  for (const role of ctx.roles) {
    for (const grant of idx.get(role)?.get(permission) ?? []) {
      const failed = firstFailure(grant.conditions, ctx, resource);
      if (failed === undefined) return { allow: true, reason: "granted", grant: frozen(grant) };
      failure ??= failed;
    }
  }
  if (failure === undefined) return deny("not_granted");

  const own = new Set(ctx.roles);
  const approverRoles: string[] = [];
  for (const [role, byPerm] of idx) {
    if (own.has(role)) continue;
    if (
      byPerm.get(permission)?.some((g) => firstFailure(g.conditions, ctx, resource) === undefined)
    )
      approverRoles.push(role);
  }
  approverRoles.sort();
  return approverRoles.length === 0
    ? deny(failure)
    : { allow: false, reason: failure, override: { permission, approverRoles } };
}

const frozen = (g: Grant): Grant => (Object.isFrozen(g) ? g : freezeGrant(g));
