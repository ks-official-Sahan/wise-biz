import { TENANCY_TENANT_TOPIC } from "../events.ts";

import type { OutboxEvent } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";

/** Anything with the defineEvent surface this module needs. */
export interface EventDef {
  readonly type: string;
  readonly version: number;
  readonly parse: (input: unknown) => unknown;
}

/**
 * Builds the outbox row for a domain event: the envelope is validated by the event's own schema, so a malformed
 * payload fails the transaction instead of reaching the bus. Key = tenant id (per-tenant ordering).
 */
export function tenancyEvent(
  def: EventDef,
  ctx: CommandContext,
  subject: string,
  data: Record<string, unknown>,
): OutboxEvent {
  const id = ctx.ids.uuidv7();
  const payload = def.parse({
    id,
    type: def.type,
    version: def.version,
    source: "api/tenancy",
    tenantId: ctx.tenant.tenantId,
    subject,
    time: ctx.now.toISOString(),
    correlationId: ctx.requestId,
    actor: { type: "user", id: ctx.userId },
    data,
  });
  return {
    id,
    topic: TENANCY_TENANT_TOPIC,
    key: ctx.tenant.tenantId,
    type: def.type,
    version: def.version,
    payload,
  };
}
