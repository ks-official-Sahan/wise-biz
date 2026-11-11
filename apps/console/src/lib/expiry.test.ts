import { describe, expect, it } from "vitest";

import {
  buildWriteOff,
  daysBetween,
  daysLeftText,
  defaultFefoRange,
  fefoRangeError,
  fefoText,
  fullQty,
  markdownEvidenceText,
  markdownText,
  writeOffEligible,
} from "./expiry.ts";

import type { WriteOffRow } from "./expiry.ts";

const LOC = "0190a000-0000-7000-8000-000000000001";
const OTHER = "0190a000-0000-7000-8000-000000000005";
const V1 = "0190a000-0000-7000-8000-000000000002";
const B1 = "0190a000-0000-7000-8000-000000000003";
const B2 = "0190a000-0000-7000-8000-000000000004";

const row = (over: Partial<WriteOffRow> = {}): WriteOffRow => ({
  batchId: B1,
  variantId: V1,
  locationId: LOC,
  qtyOnHand: "5",
  daysLeft: 3,
  qty: "2",
  ...over,
});

describe("expiry words", () => {
  it("says days left in words, including expired and today", () => {
    expect(daysLeftText(-2)).toBe("Expired 2 days ago");
    expect(daysLeftText(-1)).toBe("Expired 1 day ago");
    expect(daysLeftText(0)).toBe("Expires today");
    expect(daysLeftText(1)).toBe("1 day left");
    expect(daysLeftText(30)).toBe("30 days left");
  });

  it("allows a write-off only within the horizon, expired stock included", () => {
    expect(writeOffEligible(7)).toBe(true);
    expect(writeOffEligible(-40)).toBe(true);
    expect(writeOffEligible(8)).toBe(false);
  });

  it("states a markdown suggestion and its evidence", () => {
    expect(markdownText(0)).toBe("No markdown suggested for this batch");
    expect(markdownText(20)).toBe("Suggested 20% off, saved as a draft");
    expect(markdownEvidenceText({ stockAheadQty: "12", soldQty: "3", windowDays: 28 })).toBe(
      "3 sold in the last 28 days against 12 on hand",
    );
  });

  it("states FEFO compliance per product", () => {
    expect(fefoText({ outflows: 0, violations: 0 })).toBe("No outflows in this window");
    expect(fefoText({ outflows: 4, violations: 0 })).toBe("All 4 outflows followed FEFO");
    expect(fefoText({ outflows: 4, violations: 1 })).toBe(
      "1 of 4 outflows skipped an earlier batch",
    );
  });
});

describe("FEFO window", () => {
  it("counts whole days and defaults to the last 30", () => {
    expect(daysBetween("2026-11-01", "2026-11-11")).toBe(10);
    expect(defaultFefoRange("2026-11-11")).toEqual({ from: "2026-10-12", to: "2026-11-11" });
  });

  it("refuses a bad, reversed or over-long window", () => {
    expect(fefoRangeError("2026-11-01", "2026-11-11")).toBeNull();
    expect(fefoRangeError("", "2026-11-11")).toBe("Pick both dates.");
    expect(fefoRangeError("2026-11-11", "2026-11-01")).toBe(
      "The end date is before the start date.",
    );
    expect(fefoRangeError("2026-01-01", "2026-11-11")).toMatch(/92 days or fewer/);
  });
});

describe("buildWriteOff", () => {
  it("builds one document per location with the typed quantities", () => {
    expect(buildWriteOff([row(), row({ batchId: B2, qty: "5" })], "  breakage  ")).toEqual({
      ok: true,
      body: {
        locationId: LOC,
        note: "breakage",
        lines: [
          { variantId: V1, batchId: B1, qty: "2" },
          { variantId: V1, batchId: B2, qty: "5" },
        ],
      },
    });
  });

  it("needs at least one batch, at one location", () => {
    expect(buildWriteOff([], "").ok).toBe(false);
    const mixed = buildWriteOff([row(), row({ batchId: B2, locationId: OTHER })], "");
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.errors.get("lines")).toMatch(/one location/);
  });

  it("refuses stock outside the horizon, more than is on hand, and bad quantities", () => {
    const late = buildWriteOff([row({ daysLeft: 9 })], "");
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.errors.get(B1)).toMatch(/within 7 days/);

    const over = buildWriteOff([row({ qty: "6" })], "");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.get(B1)).toBe("Only 5 on hand.");

    expect(buildWriteOff([row({ qty: "0" })], "").ok).toBe(false);
  });

  it("writes off expired stock and offers the whole batch as the default quantity", () => {
    expect(buildWriteOff([row({ daysLeft: -3, qty: "5" })], "").ok).toBe(true);
    expect(fullQty("2.5")).toBe("2.5");
  });
});
