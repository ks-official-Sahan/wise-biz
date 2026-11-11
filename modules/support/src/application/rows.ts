import { iso } from "./shared.ts";

import type { TicketPriority, TicketStatus } from "../domain/status.ts";

/** Ticket columns every response needs. Diagnostics are read only where the detail needs them. */
export const TICKET_COLS =
  "id, branch_id, subject, status, priority, plan_code, sla_first_response_due_at, sla_resolution_due_at, first_responded_at, solved_at, created_at, updated_at";

export interface TicketRow {
  id: string;
  branch_id: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  plan_code: string;
  sla_first_response_due_at: Date;
  sla_resolution_due_at: Date;
  first_responded_at: Date | null;
  solved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TicketSummary {
  id: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  branchId: string | null;
  planCode: string;
  slaFirstResponseDueAt: string;
  slaResolutionDueAt: string;
  firstRespondedAt: string | null;
  solvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketMessage {
  id: string;
  authorKind: "tenant" | "platform";
  authorId: string;
  body: string;
  internal: boolean;
  createdAt: string;
}

export interface MessageRow {
  id: string;
  author_kind: "tenant" | "platform";
  author_id: string;
  body: string;
  internal: boolean;
  created_at: Date;
}

export const toSummary = (r: TicketRow): TicketSummary => ({
  id: r.id,
  subject: r.subject,
  status: r.status,
  priority: r.priority,
  branchId: r.branch_id,
  planCode: r.plan_code,
  slaFirstResponseDueAt: r.sla_first_response_due_at.toISOString(),
  slaResolutionDueAt: r.sla_resolution_due_at.toISOString(),
  firstRespondedAt: iso(r.first_responded_at),
  solvedAt: iso(r.solved_at),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export const toMessage = (r: MessageRow): TicketMessage => ({
  id: r.id,
  authorKind: r.author_kind,
  authorId: r.author_id,
  body: r.body,
  internal: r.internal,
  createdAt: r.created_at.toISOString(),
});
