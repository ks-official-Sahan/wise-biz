import { describe, expect, it } from "vitest";

import {
  bars,
  dailySeries,
  delta,
  describeDelta,
  eachDay,
  isoDay,
  presetRange,
  reportQuery,
  shiftDays,
  totals,
} from "./reports.ts";

import type { SalesRow } from "./reports.ts";

const row = (key: string, over: Partial<SalesRow> = {}): SalesRow => ({
  key,
  currency: "USD",
  salesCount: 2,
  subtotalMinor: 1000,
  discountMinor: 0,
  feeMinor: 0,
  taxMinor: 80,
  payableMinor: 1080,
  voidsCount: 0,
  voidsPayableMinor: 0,
  returnsCount: 0,
  returnsMinor: 0,
  netMinor: 1080,
  ...over,
});

describe("dates", () => {
  it("moves across month and year ends without a time zone in the way", () => {
    expect(shiftDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(eachDay("2026-11-01", "2026-11-03")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(eachDay("2026-11-03", "2026-11-01")).toEqual([]);
  });

  it("builds the period presets from today", () => {
    const now = new Date(2026, 10, 15, 14, 0);
    expect(isoDay(now)).toBe("2026-11-15");
    expect(presetRange("today", now)).toEqual({ from: "2026-11-15", to: "2026-11-15" });
    expect(presetRange("7d", now)).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(presetRange("30d", now)).toEqual({ from: "2026-10-17", to: "2026-11-15" });
    expect(presetRange("month", now)).toEqual({ from: "2026-11-01", to: "2026-11-15" });
    expect(presetRange("lastMonth", now)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(presetRange("lastMonth", new Date(2026, 0, 10))).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  it("leaves empty filters out of the query", () => {
    expect(reportQuery({ from: "2026-11-01", to: "2026-11-03" })).toBe(
      "from=2026-11-01&to=2026-11-03",
    );
    expect(
      reportQuery({ from: "2026-11-01", to: "2026-11-03", branchId: "b" }, { groupBy: "branch" }),
    ).toBe("from=2026-11-01&to=2026-11-03&groupBy=branch&branchId=b");
  });
});

describe("comparisons", () => {
  it("says up, down, flat or new, and never divides by zero", () => {
    expect(delta(1200, 1000)).toEqual({ pct: 20, direction: "up" });
    expect(delta(750, 1000)).toEqual({ pct: -25, direction: "down" });
    expect(delta(1000, 1000)).toEqual({ pct: 0, direction: "flat" });
    expect(delta(500, 0)).toEqual({ pct: null, direction: "new" });
    expect(delta(0, 0)).toEqual({ pct: null, direction: "flat" });
    expect(delta(-50, -100)).toEqual({ pct: 50, direction: "up" });
  });

  it("describes a change in words", () => {
    expect(describeDelta(delta(1200, 1000), "Sales")).toBe("Sales: up 20%");
    expect(describeDelta(delta(750, 1000), "Sales")).toBe("Sales: down 25%");
    expect(describeDelta(delta(1, 0), "Sales")).toBe("Sales: new, nothing to compare with");
    expect(describeDelta(delta(0, 0), "Sales")).toBe("Sales: unchanged");
  });
});

describe("chart data", () => {
  it("fills missing days with zero and counts one currency only", () => {
    const rows = [
      row("2026-11-01"),
      row("2026-11-03", { netMinor: 500 }),
      row("2026-11-02", { currency: "EUR" }),
    ];
    expect(dailySeries(rows, "2026-11-01", "2026-11-03", "USD")).toEqual([
      { day: "2026-11-01", minor: 1080 },
      { day: "2026-11-02", minor: 0 },
      { day: "2026-11-03", minor: 500 },
    ]);
  });

  it("scales bars to the tallest day and sits them on the baseline", () => {
    const b = bars(
      [
        { day: "a", minor: 100 },
        { day: "b", minor: 50 },
        { day: "c", minor: 0 },
      ],
      300,
      100,
    );
    expect(b.map((x) => x.h)).toEqual([100, 50, 0]);
    expect(b.every((x) => x.y + x.h === 100)).toBe(true);
    expect(b[0]?.x).toBeLessThan(b[1]?.x ?? 0);
    // All zero: flat bars, no division by zero.
    expect(bars([{ day: "a", minor: 0 }], 100, 50)[0]?.h).toBe(0);
    expect(bars([], 100, 50)).toEqual([]);
  });

  it("adds up a period for one currency", () => {
    const t = totals(
      [
        row("a"),
        row("b", { salesCount: 3, payableMinor: 2000, returnsMinor: 100, netMinor: 1900 }),
        row("c", { currency: "EUR" }),
      ],
      "USD",
    );
    expect(t).toMatchObject({
      salesCount: 5,
      payableMinor: 3080,
      returnsMinor: 100,
      netMinor: 2980,
      averageMinor: 616,
    });
    expect(totals([], "USD").averageMinor).toBe(0);
  });
});
