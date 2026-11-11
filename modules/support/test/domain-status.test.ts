import { describe, expect, it } from "vitest";

import {
  REOPEN_WINDOW_MS,
  TICKET_STATUSES,
  changeStatus,
  replyStatus,
} from "../src/domain/status.ts";

import type { AuthorKind, TicketStatus } from "../src/domain/status.ts";

const NOW = Date.parse("2026-06-10T12:00:00Z");
const fresh = { nowMs: NOW, solvedAtMs: NOW - 60_000 };
const solvedAgo = (ms: number) => ({ nowMs: NOW, solvedAtMs: NOW - ms });

describe("replyStatus", () => {
  it("a tenant reply moves pending to open and keeps open open", () => {
    expect(replyStatus("pending", "tenant", fresh)).toEqual({ ok: true, to: "open" });
    expect(replyStatus("open", "tenant", fresh)).toEqual({ ok: true, to: "open" });
  });

  it("a tenant reply reopens a solved ticket only within 14 days of solving", () => {
    expect(replyStatus("solved", "tenant", solvedAgo(REOPEN_WINDOW_MS))).toEqual({
      ok: true,
      to: "open",
    });
    const late = replyStatus("solved", "tenant", solvedAgo(REOPEN_WINDOW_MS + 1));
    expect(late.ok).toBe(false);
  });

  it("a solved ticket with no solved timestamp is not reopened by a reply", () => {
    expect(replyStatus("solved", "tenant", { nowMs: NOW, solvedAtMs: null }).ok).toBe(false);
  });

  it("a platform reply moves open to pending and keeps pending", () => {
    expect(replyStatus("open", "platform", fresh)).toEqual({ ok: true, to: "pending" });
    expect(replyStatus("pending", "platform", fresh)).toEqual({ ok: true, to: "pending" });
  });

  it("a platform reply on a solved ticket is refused: the tenant must reopen it first", () => {
    expect(replyStatus("solved", "platform", fresh).ok).toBe(false);
  });

  it("closed refuses every reply, from either side, and never reopens", () => {
    for (const author of ["tenant", "platform"] as const) {
      expect(replyStatus("closed", author, fresh).ok).toBe(false);
      expect(replyStatus("closed", author, solvedAgo(1)).ok).toBe(false);
    }
  });
});

describe("changeStatus", () => {
  it("the platform alone moves open to pending", () => {
    expect(changeStatus("open", "pending", "platform", fresh)).toEqual({ ok: true, to: "pending" });
    expect(changeStatus("open", "pending", "tenant", fresh).ok).toBe(false);
  });

  it("either side can solve or close an open or pending ticket", () => {
    for (const author of ["tenant", "platform"] as const) {
      for (const from of ["open", "pending"] as const) {
        expect(changeStatus(from, "solved", author, fresh).ok).toBe(true);
        expect(changeStatus(from, "closed", author, fresh).ok).toBe(true);
      }
      expect(changeStatus("solved", "closed", author, fresh).ok).toBe(true);
    }
  });

  it("solved reopens to open only within the window, for either side", () => {
    for (const author of ["tenant", "platform"] as const) {
      expect(changeStatus("solved", "open", author, solvedAgo(REOPEN_WINDOW_MS))).toEqual({
        ok: true,
        to: "open",
      });
      expect(changeStatus("solved", "open", author, solvedAgo(REOPEN_WINDOW_MS + 1)).ok).toBe(
        false,
      );
    }
  });

  it("closed is terminal: no target and no actor", () => {
    for (const author of ["tenant", "platform"] as const) {
      for (const to of TICKET_STATUSES) {
        expect(changeStatus("closed", to, author, fresh).ok).toBe(false);
      }
    }
  });

  it("refuses same-status moves and moves the table does not list", () => {
    expect(changeStatus("open", "open", "platform", fresh).ok).toBe(false);
    expect(changeStatus("solved", "solved", "platform", fresh).ok).toBe(false);
    expect(changeStatus("pending", "open", "platform", fresh).ok).toBe(false);
    expect(changeStatus("open", "solved", "platform", fresh).ok).toBe(true);
  });

  it("the refusal carries a human reason for the 409 body", () => {
    const r = changeStatus("closed", "open", "tenant", fresh);
    expect(r).toEqual({ ok: false, reason: "The ticket is closed." });
  });

  it("every (from, to, actor) triple is decided: no exceptions, no unknown states", () => {
    const states: readonly TicketStatus[] = TICKET_STATUSES;
    const actors: readonly AuthorKind[] = ["tenant", "platform"];
    for (const from of states) {
      for (const to of states) {
        for (const actor of actors) {
          const r = changeStatus(from, to, actor, fresh);
          expect(typeof r.ok).toBe("boolean");
          if (r.ok) expect(r.to).toBe(to);
        }
      }
    }
  });
});
