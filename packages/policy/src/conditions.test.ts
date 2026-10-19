import { describe, expect, it } from "vitest";

import { firstFailure, isValidConditions, type Conditions } from "./conditions.ts";
import { ctx, res } from "./fixtures.ts";

describe("isValidConditions", () => {
  it("accepts good and rejects bad shapes", () => {
    expect(
      isValidConditions({
        maxAmountMinor: 0,
        timeWindow: { startMinute: 0, endMinute: 1439, days: [0, 6] },
      }),
    ).toBe(true);
    const bads: unknown[] = [
      null,
      [],
      { maxAmountMinor: 1.5 },
      { maxDiscountBps: -1 },
      { requiresOpenShift: "y" },
      { deviceClass: [] },
      { deviceClass: ["fax"] },
      { deviceClass: "pos" },
      { timeWindow: null },
      { timeWindow: { startMinute: 0, endMinute: 1440 } },
      { timeWindow: { startMinute: 0, endMinute: 5, days: [7] } },
      { timeWindow: { startMinute: 0, endMinute: 5, days: 1 } },
    ];
    for (const b of bads) expect(isValidConditions(b)).toBe(false);
  });
});

describe("firstFailure", () => {
  const f = (c: Conditions | undefined, cx = ctx(), r = res()) => firstFailure(c, cx, r);
  it("passes with no conditions", () => {
    expect(f(undefined)).toBeUndefined();
  });
  it("amount: limit inclusive, missing value fails closed", () => {
    expect(f({ maxAmountMinor: 100 }, ctx(), res({ amountMinor: 100 }))).toBeUndefined();
    expect(f({ maxAmountMinor: 100 }, ctx(), res({ amountMinor: 101 }))).toBe(
      "amount_exceeds_limit",
    );
    expect(f({ maxAmountMinor: 100 })).toBe("amount_exceeds_limit");
  });
  it("discount: limit inclusive, missing value fails closed", () => {
    expect(f({ maxDiscountBps: 10 }, ctx(), res({ discountBps: 10 }))).toBeUndefined();
    expect(f({ maxDiscountBps: 10 }, ctx(), res({ discountBps: 11 }))).toBe(
      "discount_exceeds_limit",
    );
    expect(f({ maxDiscountBps: 10 })).toBe("discount_exceeds_limit");
  });
  it("time window: normal, end exclusive, empty", () => {
    const w = { timeWindow: { startMinute: 540, endMinute: 1020 } };
    expect(f(w, ctx({ localMinuteOfDay: 540 }))).toBeUndefined();
    expect(f(w, ctx({ localMinuteOfDay: 1019 }))).toBeUndefined();
    expect(f(w, ctx({ localMinuteOfDay: 1020 }))).toBe("outside_time_window");
    expect(f(w, ctx({ localMinuteOfDay: 539 }))).toBe("outside_time_window");
    expect(f({ timeWindow: { startMinute: 5, endMinute: 5 } }, ctx({ localMinuteOfDay: 5 }))).toBe(
      "outside_time_window",
    );
  });
  it("time window: overnight with days belongs to start day", () => {
    const w = { timeWindow: { startMinute: 1320, endMinute: 360, days: [5 as const] } }; // Fri 22:00-06:00
    expect(f(w, ctx({ localMinuteOfDay: 1380, localDayOfWeek: 5 }))).toBeUndefined();
    expect(f(w, ctx({ localMinuteOfDay: 120, localDayOfWeek: 6 }))).toBeUndefined();
    expect(f(w, ctx({ localMinuteOfDay: 120, localDayOfWeek: 5 }))).toBe("outside_time_window");
    expect(f(w, ctx({ localMinuteOfDay: 1380, localDayOfWeek: 6 }))).toBe("outside_time_window");
    expect(f(w, ctx({ localMinuteOfDay: 720, localDayOfWeek: 5 }))).toBe("outside_time_window");
    // Sunday 00:30 belongs to Saturday(6); Sunday=0 -> start day 6
    const sat = { timeWindow: { startMinute: 1320, endMinute: 360, days: [6 as const] } };
    expect(f(sat, ctx({ localMinuteOfDay: 30, localDayOfWeek: 0 }))).toBeUndefined();
  });
  it("device class", () => {
    const d = { deviceClass: ["pos", "kiosk"] as const };
    expect(f(d, ctx({ deviceClass: "pos" }))).toBeUndefined();
    expect(f(d, ctx({ deviceClass: "web" }))).toBe("device_class_not_allowed");
    expect(f(d)).toBe("device_class_not_allowed");
  });
  it("requiresOpenShift", () => {
    expect(f({ requiresOpenShift: true }, ctx({ shiftOpen: true }))).toBeUndefined();
    expect(f({ requiresOpenShift: true }, ctx({ shiftOpen: false }))).toBe("shift_not_open");
    expect(f({ requiresOpenShift: true })).toBe("shift_not_open");
    expect(f({ requiresOpenShift: false })).toBeUndefined();
  });
});
