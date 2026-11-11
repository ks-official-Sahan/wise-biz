import { describe, expect, it } from "vitest";

import { ApiError } from "./api.ts";
import {
  REOPEN_WINDOW_MS,
  authorLabel,
  buildReply,
  buildTicket,
  canReopen,
  countdownText,
  diagnosticFacts,
  whenText,
  replyHint,
  slaTarget,
  supportErrorText,
  ticketActions,
  ticketQuery,
  visibleMessages,
} from "./support.ts";

import type { TicketMessage } from "./support.ts";

const NOW = Date.parse("2026-11-11T09:00:00Z");
const HOUR = 3_600_000;

describe("ticket actions", () => {
  it("offers solve from open or pending only", () => {
    expect(ticketActions({ status: "open", solvedAt: null }, NOW).solve).toBe(true);
    expect(ticketActions({ status: "pending", solvedAt: null }, NOW).solve).toBe(true);
    expect(ticketActions({ status: "solved", solvedAt: null }, NOW).solve).toBe(false);
    expect(ticketActions({ status: "closed", solvedAt: null }, NOW).solve).toBe(false);
  });

  it("reopens a solved ticket up to exactly 14 days, and not one millisecond later", () => {
    const solvedAt = new Date(NOW - REOPEN_WINDOW_MS).toISOString();
    expect(REOPEN_WINDOW_MS).toBe(14 * 24 * HOUR);
    expect(ticketActions({ status: "solved", solvedAt }, NOW).reopen).toBe(true);
    expect(canReopen(solvedAt, NOW)).toBe(true);
    const past = new Date(NOW - REOPEN_WINDOW_MS - 1).toISOString();
    expect(ticketActions({ status: "solved", solvedAt: past }, NOW).reopen).toBe(false);
    expect(canReopen(past, NOW)).toBe(false);
  });

  it("never reopens an open or closed ticket, and says no when the solve time is unknown", () => {
    const solvedAt = new Date(NOW).toISOString();
    expect(ticketActions({ status: "open", solvedAt }, NOW).reopen).toBe(false);
    expect(ticketActions({ status: "closed", solvedAt }, NOW).reopen).toBe(false);
    expect(canReopen(null, NOW)).toBe(false);
    expect(canReopen("not a date", NOW)).toBe(false);
  });

  it("allows a reply unless the ticket is closed or solved past the window", () => {
    const recent = new Date(NOW - HOUR).toISOString();
    const old = new Date(NOW - REOPEN_WINDOW_MS - HOUR).toISOString();
    expect(ticketActions({ status: "open", solvedAt: null }, NOW).reply).toBe(true);
    expect(ticketActions({ status: "pending", solvedAt: null }, NOW).reply).toBe(true);
    expect(ticketActions({ status: "solved", solvedAt: recent }, NOW).reply).toBe(true);
    expect(ticketActions({ status: "solved", solvedAt: old }, NOW).reply).toBe(false);
    expect(ticketActions({ status: "closed", solvedAt: recent }, NOW).reply).toBe(false);
  });

  it("explains a reply that reopens, or that cannot be sent", () => {
    const recent = new Date(NOW - HOUR).toISOString();
    const old = new Date(NOW - REOPEN_WINDOW_MS - HOUR).toISOString();
    expect(replyHint({ status: "solved", solvedAt: recent }, NOW)).toBe(
      "Replying reopens this ticket.",
    );
    expect(replyHint({ status: "solved", solvedAt: old }, NOW)).toMatch(/more than 14 days/);
    expect(replyHint({ status: "closed", solvedAt: null }, NOW)).toMatch(/closed/);
    expect(replyHint({ status: "open", solvedAt: null }, NOW)).toBeNull();
  });
});

describe("forms", () => {
  it("trims the subject and body, and keeps the chosen priority", () => {
    expect(
      buildTicket({ subject: "  Till will not open ", priority: "high", body: " Help \n" }),
    ).toEqual({
      ok: true,
      body: { subject: "Till will not open", priority: "high", body: "Help" },
    });
  });

  it("requires a subject and a first message, and caps their length", () => {
    const blank = buildTicket({ subject: "  ", priority: "normal", body: "" });
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.errors.get("subject")).toMatch(/short subject/);
      expect(blank.errors.get("body")).toMatch(/Describe/);
    }
    const long = buildTicket({
      subject: "x".repeat(201),
      priority: "normal",
      body: "y".repeat(8001),
    });
    expect(long.ok).toBe(false);
    if (!long.ok) {
      expect(long.errors.get("subject")).toMatch(/200/);
      expect(long.errors.get("body")).toMatch(/8000/);
    }
    expect(
      buildTicket({ subject: "x".repeat(200), priority: "normal", body: "y".repeat(8000) }).ok,
    ).toBe(true);
  });

  it("refuses a priority the API does not know", () => {
    const r = buildTicket({ subject: "a", priority: "critical", body: "b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.get("priority")).toMatch(/priority/);
  });

  it("refuses an empty reply and sends the trimmed text", () => {
    expect(buildReply("   ").ok).toBe(false);
    expect(buildReply(" thanks ")).toEqual({ ok: true, body: { body: "thanks" } });
  });
});

describe("list paging", () => {
  it("builds the keyset query with status and cursor only when given", () => {
    expect(ticketQuery("", null)).toBe("limit=50");
    expect(ticketQuery("pending", "abc")).toBe("limit=50&status=pending&after=abc");
  });
});

describe("thread and diagnostics", () => {
  const msg = (over: Partial<TicketMessage>): TicketMessage => ({
    id: "m",
    authorKind: "tenant",
    authorId: "u",
    body: "b",
    internal: false,
    createdAt: "2026-11-11T08:00:00Z",
    ...over,
  });

  it("drops internal notes even if they reach the client", () => {
    const out = visibleMessages([
      msg({ id: "1" }),
      msg({ id: "2", internal: true, authorKind: "platform", body: "secret" }),
      msg({ id: "3", authorKind: "platform" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["1", "3"]);
    expect(authorLabel("platform")).toBe("Support");
    expect(authorLabel("tenant")).toBe("You");
  });

  it("shows only the app version and platform from the diagnostics", () => {
    expect(
      diagnosticFacts({
        appVersion: "1.4.0",
        platform: "win32",
        deviceId: "0190a000-0000-7000-8000-000000000001",
        branchId: "0190a000-0000-7000-8000-000000000002",
        lastErrors: [{ message: "boom at user@example.test" }],
      }),
    ).toEqual([
      { label: "App version", value: "1.4.0" },
      { label: "Platform", value: "win32" },
    ]);
    expect(diagnosticFacts({ lastErrors: [] })).toEqual([]);
  });
});

describe("service level countdown", () => {
  const base = {
    status: "open" as const,
    firstRespondedAt: null,
    slaFirstResponseDueAt: "2026-11-11T15:00:00Z",
    slaResolutionDueAt: "2026-11-12T07:00:00Z",
  };

  it("runs the first response clock until the platform has answered, then resolution", () => {
    expect(slaTarget(base)).toEqual({
      label: "First response due",
      dueAt: base.slaFirstResponseDueAt,
    });
    expect(
      slaTarget({ ...base, status: "pending", firstRespondedAt: "2026-11-11T08:00:00Z" }),
    ).toEqual({ label: "Resolution due", dueAt: base.slaResolutionDueAt });
  });

  it("stops the clock once solved or closed", () => {
    expect(slaTarget({ ...base, status: "solved" })).toBeNull();
    expect(slaTarget({ ...base, status: "closed" })).toBeNull();
  });

  it("counts down in days, hours and minutes, and says when it is overdue", () => {
    const due = "2026-11-11T15:00:00Z";
    expect(countdownText(due, NOW)).toBe("Due in 6h 0m");
    expect(countdownText(due, NOW + 5 * HOUR + 30 * 60_000)).toBe("Due in 30m");
    expect(countdownText("2026-11-13T11:00:00Z", NOW)).toBe("Due in 2d 2h");
    expect(countdownText(due, Date.parse("2026-11-11T16:30:00Z"))).toBe("Overdue by 1h 30m");
    expect(countdownText(due, Date.parse("2026-11-11T14:59:30Z"))).toBe("Due within a minute");
    expect(countdownText(due, Date.parse("2026-11-11T15:00:30Z"))).toBe(
      "Overdue by under a minute",
    );
    expect(countdownText("nope", NOW)).toBe("Due time not known");
  });

  it("shows the due time in the zone it is given, with the zone name", () => {
    const due = "2026-11-11T15:00:00Z";
    expect(whenText(due, "Asia/Colombo")).toMatch(/8:30\s*PM/);
    expect(whenText(due, "Asia/Colombo")).toMatch(/GMT\+5:30/);
    expect(whenText(due, "America/New_York")).toMatch(/10:00\s*AM/);
    expect(whenText(due, "UTC")).toMatch(/3:00\s*PM/);
    expect(whenText("nope", "UTC")).toBe("Unknown");
  });
});

describe("errors", () => {
  it("shows the domain reason for a 409, and falls back to the generic text without one", () => {
    const reason = new ApiError({
      status: 409,
      detail: "The reopen window has closed. Open a new ticket.",
    });
    expect(supportErrorText(reason, "fallback")).toBe(
      "The reopen window has closed. Open a new ticket.",
    );
    expect(supportErrorText(new ApiError({ status: 409 }), "fallback")).toMatch(/changed/);
  });

  it("uses the procurement wording for other failures", () => {
    expect(supportErrorText(new ApiError({ status: 404 }), "fallback")).toMatch(/not allowed|gone/);
    expect(
      supportErrorText(new ApiError({ status: 422, detail: "Subject is too long." }), "x"),
    ).toBe("Subject is too long.");
    expect(supportErrorText("oops", "Could not send.")).toBe("Could not send.");
  });
});
