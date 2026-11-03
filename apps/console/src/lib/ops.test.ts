import { describe, expect, it } from "vitest";

import { actionsFor, ago, batteryText, presence, unsyncedText } from "./devices.ts";
import { cashWalk, flagLabel, salesQuery, shiftsQuery, tenderLabel, variance } from "./sales.ts";

import type { ZReport } from "./sales.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

describe("sales helpers", () => {
  it("leaves empty filters out of the query", () => {
    expect(salesQuery({}, null)).toBe("limit=50");
    expect(
      salesQuery(
        { branchId: "b", status: "voided", from: "2026-11-01", flagged: true },
        "2026-11-02|x",
      ),
    ).toBe("limit=50&branchId=b&status=voided&from=2026-11-01&flagged=true&after=2026-11-02%7Cx");
    expect(shiftsQuery({ status: "open" }, null)).toBe("limit=50&status=open");
  });

  it("explains flags and tender kinds in words", () => {
    expect(flagLabel("price_mismatch")).toBe("Price differs from the list");
    expect(flagLabel("some_new_flag")).toBe("some new flag");
    expect(tenderLabel("gift_card")).toBe("Gift card");
    expect(tenderLabel("mobile_pay")).toBe("mobile pay");
  });

  it("reads over and short from the sign", () => {
    expect(variance(null)).toBe("unknown");
    expect(variance(0)).toBe("balanced");
    expect(variance(250)).toBe("over");
    expect(variance(-250)).toBe("short");
  });

  it("walks the drawer so the lines add up to the expected count", () => {
    const z: ZReport = {
      sales: { count: 3, payableMinor: 9000, taxMinor: 700, discountMinor: 0 },
      voids: { count: 0, payableMinor: 0 },
      returns: { count: 1, totalMinor: 500 },
      tenders: [{ kind: "cash", salesMinor: 6000, refundsMinor: 500 }],
      cash: {
        openingFloatMinor: 10_000,
        salesMinor: 6000,
        refundsMinor: 500,
        voidedMinor: 0,
        payInMinor: 200,
        payOutMinor: 300,
        floatAddMinor: 0,
        dropsMinor: 4000,
        expectedMinor: 11_400,
        countedMinor: 11_400,
        overShortMinor: 0,
      },
      drawerOpens: 5,
    };
    expect(cashWalk(z).reduce((n, r) => n + r.minor, 0)).toBe(z.cash.expectedMinor);
  });
});

describe("terminal helpers", () => {
  it("is online for 3 minutes after the last call", () => {
    expect(presence({ lastSeenAt: null }, NOW)).toBe("never");
    expect(presence({ lastSeenAt: minutesAgo(2) }, NOW)).toBe("online");
    expect(presence({ lastSeenAt: minutesAgo(4) }, NOW)).toBe("offline");
  });

  it("says how long ago in plain words", () => {
    expect(ago(null, NOW)).toBe("never");
    expect(ago(minutesAgo(0.2), NOW)).toBe("just now");
    expect(ago(minutesAgo(12), NOW)).toBe("12 min ago");
    expect(ago(minutesAgo(180), NOW)).toBe("3 h ago");
    expect(ago(minutesAgo(60 * 24 * 5), NOW)).toBe("5 days ago");
  });

  it("offers only moves the API allows, and none once a terminal is removed", () => {
    expect(actionsFor("active").map((a) => a.status)).toEqual([
      "suspended",
      "revoked",
      "blacklisted",
    ]);
    expect(actionsFor("suspended").map((a) => a.status)).toEqual([
      "active",
      "revoked",
      "blacklisted",
    ]);
    expect(actionsFor("revoked")).toEqual([]);
    expect(actionsFor("blacklisted")).toEqual([]);
    expect(actionsFor("pending").map((a) => a.status)).toEqual(["revoked", "blacklisted"]);
    expect(
      actionsFor("active")
        .filter((a) => a.danger)
        .map((a) => a.label),
    ).toEqual(["Revoke", "Blacklist"]);
  });
});

describe("terminal health", () => {
  it("says how stale the unsent backlog is, and shows missing battery as n/a", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    expect(unsyncedText({ unsyncedCount: 0, oldestUnsyncedAt: null }, now)).toBe("All sent");
    expect(unsyncedText({ unsyncedCount: 3, oldestUnsyncedAt: null }, now)).toBe("3 waiting");
    expect(unsyncedText({ unsyncedCount: 3, oldestUnsyncedAt: "2026-11-03T10:00:00Z" }, now)).toBe(
      "3 waiting, oldest 2 h ago",
    );
    expect(batteryText(null)).toBe("n/a");
    expect(batteryText(80)).toBe("80%");
  });
});
