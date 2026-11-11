import { changeStatus, replyStatus } from "../domain/status.ts";
import { TicketMessageAddedV1, TicketStatusChangedV1 } from "../events.ts";

import { TICKET_COLS, toSummary } from "./rows.ts";
import { conflict, invalid, one, notFound, supportEvent } from "./shared.ts";

import type { TicketRow, TicketMessage } from "./rows.ts";
import type { AuthorKind, TicketStatus } from "../domain/status.ts";
import type { TxHandle } from "@wise-biz/db";
import type { AuditDraft, CommandContext, CommandResult } from "@wise-biz/module-kit";

export interface ReplyInput {
  readonly body: string;
  readonly author: AuthorKind;
  /** Platform-only note: never changes the status, never counts as a first response, never shown to tenants. */
  readonly internal: boolean;
}

/** Locks the ticket row for the rest of the transaction, so two replies cannot race on the same status. */
async function lockTicket(tx: TxHandle, tenantId: string, id: string): Promise<TicketRow> {
  const r = await tx.query<TicketRow>(
    `select ${TICKET_COLS} from support.tickets where tenant_id = $1 and id = $2 for update`,
    [tenantId, id],
  );
  if (r.rows.length === 0) return notFound();
  return one(r.rows);
}

const clockOf = (ctx: CommandContext, t: TicketRow) => ({
  nowMs: ctx.now.getTime(),
  solvedAtMs: t.solved_at === null ? null : t.solved_at.getTime(),
});

/**
 * A message on a ticket. A public reply moves the status by the domain rules (tenant reply: pending or solved to open;
 * platform reply: open to pending) and stamps the first response the first time the platform answers.
 */
export async function addMessageCommand(
  tx: TxHandle,
  ctx: CommandContext,
  ticketId: string,
  input: ReplyInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  if (input.internal && input.author === "tenant") {
    invalid("internal", "only the platform can add internal notes");
  }
  const t = await lockTicket(tx, tenantId, ticketId);
  let to: TicketStatus = t.status;
  if (input.internal) {
    if (t.status === "closed") throw conflict("The ticket is closed.");
  } else {
    const decision = replyStatus(t.status, input.author, clockOf(ctx, t));
    if (!decision.ok) throw conflict(decision.reason);
    to = decision.to;
  }
  const firstResponse =
    input.author === "platform" && !input.internal && t.first_responded_at === null;
  const messageId = ctx.ids.uuidv7();

  await tx.query(
    `insert into support.ticket_messages (tenant_id, id, ticket_id, author_kind, author_id, body, internal, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, messageId, ticketId, input.author, ctx.userId, input.body, input.internal, ctx.now],
  );
  await tx.query(
    `update support.tickets
        set status = $3, first_responded_at = $4, updated_at = $5
      where tenant_id = $1 and id = $2`,
    [tenantId, ticketId, to, firstResponse ? ctx.now : t.first_responded_at, ctx.now],
  );

  const message: TicketMessage = {
    id: messageId,
    authorKind: input.author,
    authorId: ctx.userId,
    body: input.body,
    internal: input.internal,
    createdAt: ctx.now.toISOString(),
  };
  const events = [
    supportEvent(TicketMessageAddedV1, ctx, `ticket/${ticketId}`, {
      ticketId,
      messageId,
      authorKind: input.author,
      internal: input.internal,
      firstResponse,
    }),
  ];
  const audit: AuditDraft[] = [
    {
      action: "support.ticket.message_added",
      entity: "support.ticket",
      entityId: ticketId,
      after: { messageId, authorKind: input.author, internal: input.internal },
    },
  ];
  if (to !== t.status) {
    events.push(statusEvent(ctx, ticketId, t.status, to));
    audit.push(statusAudit(ticketId, t.status, to));
  }
  return { status: 201, body: message, audit, events };
}

/** An explicit status change (the status endpoint). Solving stamps `solved_at`, which starts the reopen window. */
export async function changeStatusCommand(
  tx: TxHandle,
  ctx: CommandContext,
  ticketId: string,
  to: TicketStatus,
  actor: AuthorKind,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const t = await lockTicket(tx, tenantId, ticketId);
  const decision = changeStatus(t.status, to, actor, clockOf(ctx, t));
  if (!decision.ok) throw conflict(decision.reason);
  const solvedAt = to === "solved" ? ctx.now : t.solved_at;
  const r = await tx.query<TicketRow>(
    `update support.tickets
        set status = $3, solved_at = $4, updated_at = $5
      where tenant_id = $1 and id = $2
      returning ${TICKET_COLS}`,
    [tenantId, ticketId, to, solvedAt, ctx.now],
  );
  return {
    status: 200,
    body: toSummary(one(r.rows)),
    audit: [statusAudit(ticketId, t.status, to)],
    events: [statusEvent(ctx, ticketId, t.status, to)],
  };
}

const statusEvent = (ctx: CommandContext, ticketId: string, from: TicketStatus, to: TicketStatus) =>
  supportEvent(TicketStatusChangedV1, ctx, `ticket/${ticketId}`, { ticketId, from, to });

const statusAudit = (ticketId: string, from: TicketStatus, to: TicketStatus) => ({
  action: "support.ticket.status_changed",
  entity: "support.ticket",
  entityId: ticketId,
  after: { from, to },
});
