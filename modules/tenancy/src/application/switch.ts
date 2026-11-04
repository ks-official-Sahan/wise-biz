import { appendAudit, withTenantTx, withUserTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";

import type { ActiveTenantSetter, TenancyRepository } from "../ports/tenancy-repository.ts";
import type pg from "pg";

/**
 * Switch the session to a tenant. Order: verify an ACTIVE membership (404 otherwise) -> audit row in the TARGET tenant
 * (`tenancy.session.switched`, entity session) -> move the session. Audit first, so a switch is never unaudited.
 */
export async function switchTenant(
  deps: { pool: pg.Pool; repo: TenancyRepository; sessions: ActiveTenantSetter },
  input: { userId: string; sessionId: string; tenantId: string; requestId: string },
): Promise<void> {
  const { userId, sessionId, tenantId, requestId } = input;
  const member = await withUserTx(deps.pool, { userId, requestId }, (tx) =>
    deps.repo.hasActiveMembership(tx, userId, tenantId),
  );
  if (!member) throw new DomainError("NOT_FOUND", "Not found");
  await withTenantTx(deps.pool, { tenantId, userId, requestId }, (tx) =>
    appendAudit(tx, [
      {
        actorType: "user",
        actorId: userId,
        action: "tenancy.session.switched",
        entity: "tenancy.session",
        entityId: sessionId,
        requestId,
      },
    ]),
  );
  await deps.sessions.setActiveTenant(sessionId, userId, tenantId);
}
