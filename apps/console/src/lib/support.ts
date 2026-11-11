"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ApiError, api } from "./api.ts";
import { actionErrorText } from "./procurement.ts";
import { STALE } from "./queries.ts";

import type { Built } from "./procurement.ts";

// ---- shapes (mirror modules/support/src/schemas.ts) ----

export type TicketStatus = "open" | "pending" | "solved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";

export interface TicketSummary {
  readonly id: string;
  readonly subject: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority;
  readonly branchId: string | null;
  readonly planCode: string;
  readonly slaFirstResponseDueAt: string;
  readonly slaResolutionDueAt: string;
  readonly firstRespondedAt: string | null;
  readonly solvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TicketMessage {
  readonly id: string;
  readonly authorKind: "tenant" | "platform";
  readonly authorId: string;
  readonly body: string;
  readonly internal: boolean;
  readonly createdAt: string;
}

/** The API sends the whole diagnostic bundle; the screens show only `appVersion` and `platform` (see diagnosticFacts). */
export interface TicketDiagnostics {
  readonly appVersion?: string;
  readonly platform?: string;
  readonly deviceId?: string;
  readonly branchId?: string;
  readonly lastErrors: readonly { readonly message: string }[];
}

export interface TicketDetail extends TicketSummary {
  readonly diagnostics: TicketDiagnostics;
  readonly messages: readonly TicketMessage[];
  readonly messagesTruncated: boolean;
}

// ---- keys and fetchers ----

export const supportKeys = {
  all: (t: string) => [t, "support"] as const,
  tickets: (t: string, status: TicketStatus | "") => [t, "support", "tickets", status] as const,
  ticket: (t: string, id: string) => [t, "support", "ticket", id] as const,
};

const PAGE_SIZE = "50";

/** Query string for a keyset page: the API pages by the opaque `after` cursor and answers `nextCursor`. */
export function ticketQuery(status: TicketStatus | "", after: string | null): string {
  const q = new URLSearchParams({ limit: PAGE_SIZE });
  if (status !== "") q.set("status", status);
  if (after !== null) q.set("after", after);
  return q.toString();
}

export const useTickets = (t: string, status: TicketStatus | "") =>
  useInfiniteQuery({
    queryKey: supportKeys.tickets(t, status),
    queryFn: ({ signal, pageParam }) =>
      api<{ items: TicketSummary[]; nextCursor: string | null }>(
        "GET",
        `/v1/support/tickets?${ticketQuery(status, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const useTicket = (t: string, id: string) =>
  useQuery({
    queryKey: supportKeys.ticket(t, id),
    queryFn: ({ signal }) =>
      api<TicketDetail>("GET", `/v1/support/tickets/${encodeURIComponent(id)}`, { signal }),
    staleTime: STALE.live,
  });

// ---- status words ----

export const TICKET_STATUS_LABEL: Readonly<Record<TicketStatus, string>> = {
  open: "Open",
  pending: "Awaiting your reply",
  solved: "Solved",
  closed: "Closed",
};

export const PRIORITY_LABEL: Readonly<Record<TicketPriority, string>> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const TICKET_STATUSES: readonly TicketStatus[] = ["open", "pending", "solved", "closed"];
export const TICKET_PRIORITIES: readonly TicketPriority[] = ["low", "normal", "high", "urgent"];

export const isTicketPriority = (v: string): v is TicketPriority =>
  (TICKET_PRIORITIES as readonly string[]).includes(v);

// ---- what a tenant may do (domain/status.ts: EDGES and replyStatus, mirrored; the API decides) ----

/** Mirrors REOPEN_WINDOW_MS in modules/support/src/domain/status.ts. */
export const REOPEN_WINDOW_MS = 14 * 24 * 3_600_000;

/** Solved within the reopen window (inclusive, as the server counts it). Unknown or unparseable times say no. */
export function canReopen(solvedAt: string | null, nowMs: number): boolean {
  if (solvedAt === null) return false;
  const solved = Date.parse(solvedAt);
  return Number.isFinite(solved) && nowMs - solved <= REOPEN_WINDOW_MS;
}

/**
 * Which actions a tenant offers on a ticket. Solve: from open or pending. Reopen: only from solved, inside the window.
 * Reply: not on a closed ticket, and not on a solved one outside the window (a reply on solved reopens it).
 */
export function ticketActions(t: Pick<TicketSummary, "status" | "solvedAt">, nowMs: number) {
  const reopen = t.status === "solved" && canReopen(t.solvedAt, nowMs);
  return {
    solve: t.status === "open" || t.status === "pending",
    reopen,
    reply: t.status !== "closed" && (t.status !== "solved" || reopen),
  };
}

/** Plain words under the reply box when a reply will not go as a normal reply. Null when nothing needs saying. */
export function replyHint(
  t: Pick<TicketSummary, "status" | "solvedAt">,
  nowMs: number,
): string | null {
  if (t.status === "closed") return "This ticket is closed. Open a new ticket to get more help.";
  if (t.status === "solved")
    return canReopen(t.solvedAt, nowMs)
      ? "Replying reopens this ticket."
      : "This ticket was solved more than 14 days ago. Open a new ticket to get more help.";
  return null;
}

/** The thread a tenant may see. The API already leaves internal notes out; this keeps them out even if it did not. */
export function visibleMessages(messages: readonly TicketMessage[]): readonly TicketMessage[] {
  return messages.filter((m) => !m.internal);
}

export const authorLabel = (kind: TicketMessage["authorKind"]): string =>
  kind === "platform" ? "Support" : "You";

/**
 * Diagnostics shown to the tenant: the app version and the platform, nothing else (no ids, no error text).
 * Only values that are present are returned.
 */
export function diagnosticFacts(d: TicketDiagnostics): readonly { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (d.appVersion !== undefined) out.push({ label: "App version", value: d.appVersion });
  if (d.platform !== undefined) out.push({ label: "Platform", value: d.platform });
  return out;
}

// ---- forms ----

export const SUBJECT_MAX = 200;
export const BODY_MAX = 8000;

export interface TicketForm {
  readonly subject: string;
  readonly priority: string;
  readonly body: string;
}

export interface TicketBody {
  readonly subject: string;
  readonly priority: TicketPriority;
  readonly body: string;
}

export function buildTicket(f: TicketForm): Built<TicketBody> {
  const errors = new Map<string, string>();
  const subject = f.subject.trim();
  const body = f.body.trim();
  if (subject === "") errors.set("subject", "Enter a short subject, like Till will not open.");
  else if (subject.length > SUBJECT_MAX)
    errors.set("subject", `Keep the subject to ${String(SUBJECT_MAX)} characters.`);
  if (body === "") errors.set("body", "Describe what you need help with.");
  else if (body.length > BODY_MAX)
    errors.set("body", `Keep the message to ${String(BODY_MAX)} characters.`);
  if (!isTicketPriority(f.priority)) errors.set("priority", "Pick a priority.");
  if (errors.size > 0 || !isTicketPriority(f.priority)) return { ok: false, errors };
  return { ok: true, body: { subject, priority: f.priority, body } };
}

export function buildReply(text: string): Built<{ readonly body: string }> {
  const body = text.trim();
  if (body === "") return { ok: false, errors: new Map([["body", "Write a reply first."]]) };
  if (body.length > BODY_MAX)
    return {
      ok: false,
      errors: new Map([["body", `Keep the message to ${String(BODY_MAX)} characters.`]]),
    };
  return { ok: true, body: { body } };
}

// ---- time ----

/** The viewer's own zone (the browser's), or undefined where the runtime cannot say. */
export function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Absolute due time in a zone, with the zone's name so a reader abroad is not misled. */
export function whenText(dueAt: string, timeZone: string | undefined, locale = "en-US"): string {
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(d);
}

const MINUTE_MS = 60_000;

/** "Due in 6h 0m", "Overdue by 2d 3h". Pure: the caller passes the clock. */
export function countdownText(dueAt: string, nowMs: number): string {
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return "Due time not known";
  const diff = due - nowMs;
  const abs = Math.abs(diff);
  if (abs < MINUTE_MS) return diff >= 0 ? "Due within a minute" : "Overdue by under a minute";
  const mins = Math.floor(abs / MINUTE_MS);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const minutes = mins % 60;
  const span =
    days > 0
      ? `${String(days)}d ${String(hours)}h`
      : hours > 0
        ? `${String(hours)}h ${String(minutes)}m`
        : `${String(minutes)}m`;
  return diff >= 0 ? `Due in ${span}` : `Overdue by ${span}`;
}

/** The SLA clock that is running: first response until the platform has answered, then resolution. Null when stopped. */
export function slaTarget(
  t: Pick<
    TicketSummary,
    "status" | "firstRespondedAt" | "slaFirstResponseDueAt" | "slaResolutionDueAt"
  >,
): { readonly label: string; readonly dueAt: string } | null {
  if (t.status === "solved" || t.status === "closed") return null;
  return t.firstRespondedAt === null
    ? { label: "First response due", dueAt: t.slaFirstResponseDueAt }
    : { label: "Resolution due", dueAt: t.slaResolutionDueAt };
}

export interface ViewerClock {
  readonly nowMs: number;
  readonly timeZone: string | undefined;
}

/**
 * The clock for time-dependent text. Null until mounted, so the server render and the first client render agree
 * (zone and clock differ between them). Refreshes every 30 seconds.
 */
export function useViewerClock(refreshMs = 30_000): ViewerClock | null {
  const [clock, setClock] = useState<ViewerClock | null>(null);
  useEffect(() => {
    const tick = () => {
      setClock({ nowMs: Date.now(), timeZone: viewerTimeZone() });
    };
    tick();
    const id = setInterval(tick, refreshMs);
    return () => {
      clearInterval(id);
    };
  }, [refreshMs]);
  return clock;
}

// ---- errors ----

/** A 409 carries the domain reason (for example "The reopen window has closed"), so its detail is shown as it is. */
export function supportErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 409)
    return err.problem.detail ?? "This ticket changed. Reload it and try again.";
  return actionErrorText(err, fallback);
}
