import { newBusiness } from "../domain/business.ts";
import { TENANCY_TENANT_TOPIC, TenantCreatedV1 } from "../events.ts";

import type { Clock, Ids, TenancyRepository, Tx } from "../ports/tenancy-repository.ts";
import type { SignUpBusinessInput } from "../schemas.ts";

export interface BusinessCommandCtx {
  tenant: { tenantId: string };
  userId: string;
  requestId: string;
  now: Date;
}

/**
 * signUpBusiness handler for runCommand: tenant, 6 system roles + default grants, branch, default location,
 * owner membership + owner role (7 statements), then audit + outbox (appended by runCommand in the SAME tx).
 * The permissions_version trigger bumps the version once per statement that touches grants or membership roles.
 */
export async function signUpBusinessCommand(
  deps: { repo: TenancyRepository; clock: Clock; ids: Ids },
  tx: Tx,
  ctx: BusinessCommandCtx,
  input: SignUpBusinessInput,
) {
  const rows = newBusiness(input, {
    ownerUserId: ctx.userId,
    nextId: () => deps.ids.uuidv7(),
    now: ctx.now,
  });
  await deps.repo.insertBusiness(tx, rows);

  const tenantId = rows.tenant.tenantId;
  const dto = {
    tenantId,
    name: rows.tenant.name,
    branchId: rows.branch.id,
    locationId: rows.location.id,
  };
  const event = TenantCreatedV1.parse({
    id: deps.ids.uuidv7(),
    type: TenantCreatedV1.type,
    version: TenantCreatedV1.version,
    source: "api/tenancy",
    tenantId,
    subject: `tenant/${tenantId}`,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor: { type: "user", id: ctx.userId },
    data: { ...dto, ownerUserId: ctx.userId },
  });
  return {
    status: 201 as const,
    body: dto,
    audit: [
      {
        action: "tenancy.tenant.created",
        entity: "tenancy.tenant",
        entityId: tenantId,
        after: { ...dto, ownerUserId: ctx.userId },
      },
    ],
    events: [
      {
        id: event.id,
        topic: TENANCY_TENANT_TOPIC,
        key: tenantId,
        type: event.type,
        version: event.version,
        payload: event,
      },
    ],
  };
}
