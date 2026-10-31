import { describe, expect, it } from "vitest";

import {
  channelFor,
  channelsForBranch,
  MAX_TICKET_CHANNELS,
  noticesOf,
  redisChannel,
  signTicket,
  verifyTicket,
} from "../src/index.ts";

const SECRET = "k".repeat(32);
const TID = "0192f2a0-0000-7000-8000-000000000001";
const claims = { v: 1 as const, tid: TID, sub: "dev-1", ch: ["all:prices"], exp: 2000 };

describe("stream ticket", () => {
  it("round-trips until it expires", () => {
    const t = signTicket(SECRET, claims);
    expect(verifyTicket(SECRET, t, 1_999_999)).toEqual(claims);
    expect(verifyTicket(SECRET, t, 2_000_000)).toBeUndefined();
  });

  it("rejects another key, a changed body, a changed mac and junk", () => {
    const t = signTicket(SECRET, claims);
    const [body, mac] = t.split(".") as [string, string];
    expect(verifyTicket("x".repeat(32), t, 0)).toBeUndefined();
    const other =
      signTicket(SECRET, { ...claims, ch: ["all:catalog", "all:prices"] }).split(".")[0] ?? "";
    expect(verifyTicket(SECRET, `${other}.${mac}`, 0)).toBeUndefined();
    expect(verifyTicket(SECRET, `${body}.${mac.slice(0, -2)}AA`, 0)).toBeUndefined();
    for (const junk of ["", "abc", "a.b.c", "!!.??", `${body}.`, "x".repeat(9000)]) {
      expect(verifyTicket(SECRET, junk, 0)).toBeUndefined();
    }
  });

  it("rejects a correctly signed body that is not a ticket", () => {
    const bad = signTicket(SECRET, { ...claims, tid: "not-a-uuid" });
    expect(verifyTicket(SECRET, bad, 0)).toBeUndefined();
    const tooMany = signTicket(SECRET, {
      ...claims,
      ch: Array.from({ length: 65 }, (_, i) => `c${String(i)}`),
    });
    expect(verifyTicket(SECRET, tooMany, 0)).toBeUndefined();
  });
});

describe("channels", () => {
  it("names branch-independent and per-location channels", () => {
    expect(channelFor("prices", "all")).toBe("all:prices");
    expect(channelFor("stock_branch", "L1")).toBe("l:L1:stock_branch");
    expect(redisChannel(TID, "all:prices")).toBe(`rt:${TID}:all:prices`);
  });

  it("a branch hears every shared dataset and only its own locations' stock, capped", () => {
    expect(channelsForBranch(["catalog", "stock_branch"], ["L1", "L2"])).toEqual([
      "all:catalog",
      "l:L1:stock_branch",
      "l:L2:stock_branch",
    ]);
    const many = Array.from({ length: 200 }, (_, i) => `L${String(i)}`);
    expect(channelsForBranch(["stock_branch"], many)).toHaveLength(MAX_TICKET_CHANNELS);
  });

  it("one notice per distinct channel", () => {
    const rows = [
      { dataset: "prices" as const, scopeKey: "all" },
      { dataset: "prices" as const, scopeKey: "all" },
      { dataset: "stock_branch" as const, scopeKey: "L1" },
    ];
    expect(noticesOf(TID, rows).map((n) => n.channel)).toEqual(["all:prices", "l:L1:stock_branch"]);
  });
});
