import { isUuidv7 } from "@wise-biz/ids";

import type { AuthResolver, MembershipLoader, SessionReader } from "./types.ts";
import type { AuthContext } from "@wise-biz/module-kit";

const ANON: AuthContext = Object.freeze({ kind: "anonymous" });

export interface SessionResolverDeps {
  sessions: SessionReader;
  memberships: MembershipLoader;
  /** Session cookie name; requests without it never touch the session store. */
  cookieName: string;
}

/**
 * Production resolver: identity session -> fresh tenancy membership check on EVERY request.
 * Fail closed: no/invalid session -> anonymous; session without a usable tenant, or whose membership is missing or
 * suspended -> signed in with tenantId null (requireTenant answers 404). Infrastructure errors propagate (500) and
 * never grant anything. Tenant context comes only from the stored session + membership, never a header or body.
 */
export function sessionResolver(deps: SessionResolverDeps): AuthResolver {
  return async (c) => {
    const cookie = c.req.header("cookie");
    if (!cookie?.includes(deps.cookieName)) return ANON;
    const session = await deps.sessions.getSession(c.req.raw.headers);
    if (session === null) return ANON;

    const base = { kind: "user", userId: session.userId, sessionId: session.sessionId } as const;
    const noTenant: AuthContext = {
      ...base,
      tenantId: null,
      roles: [],
      branchScope: [],
      permissionsVersion: 0,
    };
    const tenantId = session.activeTenantId;
    if (tenantId === null || !isUuidv7(tenantId)) return noTenant;

    const m = await deps.memberships.loadMembership(session.userId, tenantId, c.get("requestId"));
    if (m === null) return noTenant;
    return {
      ...base,
      tenantId,
      roles: m.roles,
      branchScope: m.branchScope,
      permissionsVersion: m.permissionsVersion,
    };
  };
}
