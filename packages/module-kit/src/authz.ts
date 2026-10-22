import { DomainError } from "@wise-biz/errors";
import { decide } from "@wise-biz/policy";

import type { AppEnv } from "./types.ts";
import type { TenantCtx } from "@wise-biz/db";
import type { Permission, PolicyMatrix } from "@wise-biz/policy";
import type { Context, MiddlewareHandler } from "hono";

interface PolicyState {
  matrix: PolicyMatrix;
  now: () => number;
}

// Keyed by the raw Request so AppEnv stays minimal; one entry per request, collected with it.
const states = new WeakMap<Request, PolicyState>();

/** Inject the policy matrix for this request. Normally called by `policyMiddleware`. */
export function setPolicy(
  c: Context<AppEnv>,
  state: { matrix: PolicyMatrix; now?: () => number },
): void {
  states.set(c.req.raw, { matrix: state.matrix, now: state.now ?? Date.now });
}

export function policyMiddleware(
  matrix: PolicyMatrix,
  clock: { now(): number } = { now: Date.now },
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    setPolicy(c, { matrix, now: () => clock.now() });
    await next();
  };
}

/** Signed-in caller without needing an active tenant. Anonymous callers get UNAUTHENTICATED (401). */
export function requireUser(c: Context<AppEnv>): { userId: string; sessionId: string } {
  const auth = c.get("auth");
  if (auth.kind !== "user") throw new DomainError("UNAUTHENTICATED", "Authentication required");
  return { userId: auth.userId, sessionId: auth.sessionId };
}

/**
 * Tenant context of the caller. Anonymous callers get UNAUTHENTICATED (401);
 * a signed-in caller with no valid active tenant gets NOT_FOUND (404).
 */
export function requireTenant(c: Context<AppEnv>): TenantCtx {
  const auth = c.get("auth");
  if (auth.kind !== "user") throw new DomainError("UNAUTHENTICATED", "Authentication required");
  if (auth.tenantId === null) throw new DomainError("NOT_FOUND", "Not found");
  const existing = c.get("tenant");
  if (existing !== undefined) return existing;
  return { tenantId: auth.tenantId, userId: auth.userId, requestId: c.get("requestId") };
}

export interface AuthorizeResource {
  branchId?: string;
  amountMinor?: number;
  discountBps?: number;
}

/**
 * Throws unless the caller holds `permission` for this resource.
 * Not granted / tenant / branch / context denials are NOT_FOUND (a surface never confirms it exists).
 * Condition denials are PRECONDITION_FAILED, with details.override listing approver roles when any.
 */
export function authorize(
  c: Context<AppEnv>,
  permission: Permission,
  resource: AuthorizeResource = {},
): void {
  const tenant = requireTenant(c);
  const auth = c.get("auth");
  if (auth.kind !== "user") throw new DomainError("UNAUTHENTICATED", "Authentication required");
  const state = states.get(c.req.raw);
  if (state === undefined) throw new DomainError("INTERNAL", "policy not configured");

  const at = new Date(state.now());
  const decision = decide(
    state.matrix,
    {
      tenantId: tenant.tenantId,
      roles: auth.roles,
      branchScope: auth.branchScope,
      now: at.getTime(),
      // Branch-local time is not known here yet; UTC until branch timezones land.
      localMinuteOfDay: at.getUTCHours() * 60 + at.getUTCMinutes(),
      localDayOfWeek: at.getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6,
    },
    permission,
    { tenantId: tenant.tenantId, ...resource },
  );
  if (decision.allow) return;
  switch (decision.reason) {
    case "tenant_mismatch":
    case "invalid_context":
    case "branch_out_of_scope":
    case "not_granted":
      throw new DomainError("NOT_FOUND", "Not found", {
        details: { permission, reason: decision.reason },
      });
    default:
      throw new DomainError("PRECONDITION_FAILED", "Precondition failed", {
        details: { permission, reason: decision.reason, override: decision.override },
      });
  }
}
