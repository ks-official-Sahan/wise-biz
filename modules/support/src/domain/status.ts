/**
 * Ticket status rules. Pure: the caller passes the clock (epoch ms) and the ticket's solved timestamp.
 * `closed` is terminal. Reopening a solved ticket is allowed only within REOPEN_WINDOW_MS of `solvedAt`.
 */

export const TICKET_STATUSES = ["open", "pending", "solved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export type AuthorKind = "tenant" | "platform";

export const REOPEN_WINDOW_MS = 14 * 24 * 3_600_000;

export type StatusDecision =
  | { readonly ok: true; readonly to: TicketStatus }
  | { readonly ok: false; readonly reason: string };

export interface StatusClock {
  readonly nowMs: number;
  /** Epoch ms when the ticket was last solved; null if it never was. */
  readonly solvedAtMs: number | null;
}

const reopenAllowed = (clock: StatusClock): boolean =>
  clock.solvedAtMs !== null && clock.nowMs - clock.solvedAtMs <= REOPEN_WINDOW_MS;

/**
 * A message from `author` on a ticket in status `from`:
 *  - platform reply: open -> pending (pending stays pending); solved or closed refuse it;
 *  - tenant reply: pending -> open; solved -> open within the reopen window; open stays open; closed refuses it.
 */
export function replyStatus(
  from: TicketStatus,
  author: AuthorKind,
  clock: StatusClock,
): StatusDecision {
  if (from === "closed") return refuse("The ticket is closed.");
  if (author === "platform") {
    if (from === "open" || from === "pending") return { ok: true, to: "pending" };
    return refuse("The ticket is solved. Reopen it before replying.");
  }
  if (from === "open") return { ok: true, to: "open" };
  if (from === "pending") return { ok: true, to: "open" };
  if (reopenAllowed(clock)) return { ok: true, to: "open" };
  return refuse("The reopen window has closed. Open a new ticket.");
}

interface Edge {
  readonly to: TicketStatus;
  readonly by: readonly AuthorKind[];
  readonly reopen: boolean;
}

const BOTH: readonly AuthorKind[] = ["tenant", "platform"];
const PLATFORM: readonly AuthorKind[] = ["platform"];

/** Explicit status changes. Anything not listed is refused. */
const EDGES: Readonly<Record<TicketStatus, readonly Edge[]>> = {
  open: [
    { to: "pending", by: PLATFORM, reopen: false },
    { to: "solved", by: BOTH, reopen: false },
    { to: "closed", by: BOTH, reopen: false },
  ],
  pending: [
    { to: "solved", by: BOTH, reopen: false },
    { to: "closed", by: BOTH, reopen: false },
  ],
  solved: [
    { to: "open", by: BOTH, reopen: true },
    { to: "closed", by: BOTH, reopen: false },
  ],
  closed: [],
};

/** An explicit status change by `actor` (the status endpoint). Same-status and unlisted moves are refused. */
export function changeStatus(
  from: TicketStatus,
  to: TicketStatus,
  actor: AuthorKind,
  clock: StatusClock,
): StatusDecision {
  if (from === "closed") return refuse("The ticket is closed.");
  const edge = EDGES[from].find((e) => e.to === to);
  if (edge === undefined) return refuse(`A ticket cannot move from ${from} to ${to}.`);
  if (!edge.by.includes(actor)) return refuse(`Only the platform can set ${to}.`);
  if (edge.reopen && !reopenAllowed(clock)) {
    return refuse("The reopen window has closed. Open a new ticket.");
  }
  return { ok: true, to };
}

const refuse = (reason: string): StatusDecision => ({ ok: false, reason });
