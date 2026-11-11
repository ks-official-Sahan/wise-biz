import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/**
 * One topic keyed by tenant. Payloads carry ids, statuses and SLA times only: never the message body and never the
 * diagnostic bundle (consumers that need the text read it through the API, with the tenant's own access).
 *
 * Names have three segments because the registry accepts only `module.entity.verb` (`support.ticket.created`), so the
 * task's `support.ticket_created@v1` is written as type `support.ticket.created` with version 1.
 */
export const SUPPORT_TOPIC = "support";

const TicketStatusEnum = z.enum(["open", "pending", "solved", "closed"]);

export const TicketCreatedV1 = defineEvent(
  "support.ticket.created",
  1,
  z.object({
    ticketId: z.string(),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    status: TicketStatusEnum,
    planCode: z.string(),
    slaFirstResponseDueAt: z.string(),
    slaResolutionDueAt: z.string(),
  }),
);

export const TicketMessageAddedV1 = defineEvent(
  "support.ticket.message_added",
  1,
  z.object({
    ticketId: z.string(),
    messageId: z.string(),
    authorKind: z.enum(["tenant", "platform"]),
    internal: z.boolean(),
    /** True when this message is the platform's first public reply (the first-response SLA is met). */
    firstResponse: z.boolean(),
  }),
);

export const TicketStatusChangedV1 = defineEvent(
  "support.ticket.status_changed",
  1,
  z.object({
    ticketId: z.string(),
    from: TicketStatusEnum,
    to: TicketStatusEnum,
  }),
);

export const SUPPORT_EVENTS = [
  TicketCreatedV1,
  TicketMessageAddedV1,
  TicketStatusChangedV1,
] as const;
