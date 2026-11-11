import { sanitizeDiagnostics } from "../domain/diagnostics.ts";
import { resolvePlan, slaDueTimes } from "../domain/sla.ts";
import { TicketCreatedV1 } from "../events.ts";

import { messagesOf } from "./messages.ts";
import { TICKET_COLS, toSummary } from "./rows.ts";
import {
  decodeCursor,
  encodeCursor,
  invalid,
  notFound,
  one,
  page,
  supportEvent,
} from "./shared.ts";

import type { TicketRow, TicketSummary, TicketMessage } from "./rows.ts";
import type { DiagnosticBundle } from "../domain/diagnostics.ts";
import type { SupportDeps } from "../port.ts";
import type { CreateTicketSchema, TicketListQuery } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

type CreateInput = z.infer<typeof CreateTicketSchema>;
type ListInput = z.infer<typeof TicketListQuery>;

export interface TicketDetail extends TicketSummary {
  diagnostics: DiagnosticBundle;
  messages: TicketMessage[];
  messagesTruncated: boolean;
}

/**
 * Opens a ticket with its first message. The plan comes from the plan port (never from the request), the diagnostics
 * are sanitised before they are stored, and the event carries ids and SLA times only.
 */
export async function createTicketCommand(
  tx: TxHandle,
  ctx: CommandContext,
  b: CreateInput,
  ports: SupportDeps,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  if (b.branchId !== undefined && !(await ports.refs.branchExists(tx, tenantId, b.branchId))) {
    invalid("branchId", "unknown branch");
  }
  const planCode = resolvePlan(await ports.plans(tx, tenantId));
  const due = slaDueTimes(ctx.now.getTime(), planCode);
  const diagnostics = sanitizeDiagnostics(b.diagnostics ?? {});
  const ticketId = ctx.ids.uuidv7();
  const messageId = ctx.ids.uuidv7();

  const r = await tx.query<TicketRow>(
    `insert into support.tickets (tenant_id, id, branch_id, subject, status, priority, created_by, plan_code,
       sla_first_response_due_at, sla_resolution_due_at, diagnostics, created_at, updated_at)
     values ($1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10::jsonb, $11, $11)
     returning ${TICKET_COLS}`,
    [
      tenantId,
      ticketId,
      b.branchId ?? null,
      b.subject,
      b.priority,
      ctx.userId,
      planCode,
      new Date(due.firstResponseDueMs),
      new Date(due.resolutionDueMs),
      JSON.stringify(diagnostics),
      ctx.now,
    ],
  );
  await tx.query(
    `insert into support.ticket_messages (tenant_id, id, ticket_id, author_kind, author_id, body, internal, created_at)
     values ($1, $2, $3, 'tenant', $4, $5, false, $6)`,
    [tenantId, messageId, ticketId, ctx.userId, b.body, ctx.now],
  );

  const ticket = toSummary(one(r.rows));
  const message: TicketMessage = {
    id: messageId,
    authorKind: "tenant",
    authorId: ctx.userId,
    body: b.body,
    internal: false,
    createdAt: ctx.now.toISOString(),
  };
  const body: TicketDetail = {
    ...ticket,
    diagnostics,
    messages: [message],
    messagesTruncated: false,
  };
  return {
    status: 201,
    body,
    audit: [
      {
        action: "support.ticket.created",
        entity: "support.ticket",
        entityId: ticketId,
        after: { status: "open", priority: b.priority, planCode },
      },
    ],
    events: [
      supportEvent(TicketCreatedV1, ctx, `ticket/${ticketId}`, {
        ticketId,
        priority: b.priority,
        status: "open",
        planCode,
        slaFirstResponseDueAt: ticket.slaFirstResponseDueAt,
        slaResolutionDueAt: ticket.slaResolutionDueAt,
      }),
    ],
  };
}

/** Newest first, keyset on (created_at, id). Summaries only: the list never carries bodies or diagnostics. */
export async function listTickets(
  tx: TxHandle,
  tenantId: string,
  q: ListInput,
): Promise<{ items: TicketSummary[]; nextCursor: string | null }> {
  const params: unknown[] = [tenantId];
  const where = ["tenant_id = $1"];
  if (q.status !== undefined) {
    params.push(q.status);
    where.push(`status = $${String(params.length)}`);
  }
  if (q.after !== undefined) {
    const c = decodeCursor(q.after);
    params.push(c.createdAt, c.id);
    where.push(`(created_at, id) < ($${String(params.length - 1)}, $${String(params.length)})`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<TicketRow>(
    `select ${TICKET_COLS} from support.tickets
      where ${where.join(" and ")}
      order by created_at desc, id desc limit $${String(params.length)}`,
    params,
  );
  return page(r.rows.map(toSummary), q.limit, (last) =>
    encodeCursor(new Date(last.createdAt), last.id),
  );
}

/**
 * One ticket with its thread. A tenant never sees internal notes: the filter is in the query, not in the client.
 * Missing and other tenants' tickets are both 404 (RLS returns no row).
 */
export async function getTicket(
  tx: TxHandle,
  tenantId: string,
  id: string,
  viewer: "tenant" | "platform",
): Promise<TicketDetail> {
  const t = await tx.query<TicketRow & { diagnostics: DiagnosticBundle }>(
    `select ${TICKET_COLS}, diagnostics from support.tickets where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  const row = t.rows[0];
  if (row === undefined) return notFound();
  const { messages, truncated } = await messagesOf(tx, tenantId, id, viewer);
  return {
    ...toSummary(row),
    diagnostics: row.diagnostics,
    messages,
    messagesTruncated: truncated,
  };
}
