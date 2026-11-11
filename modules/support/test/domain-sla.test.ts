import { describe, expect, it } from "vitest";

import { resolvePlan, slaDueTimes } from "../src/domain/sla.ts";

const HOUR = 3_600_000;
const utc = (iso: string) => Date.parse(iso);

describe("SLA targets by plan", () => {
  it("free 48h first response / 120h resolution, pro 8h / 48h, business 2h / 24h", () => {
    const at = utc("2026-05-01T09:00:00Z");
    expect(slaDueTimes(at, "free")).toEqual({
      firstResponseDueMs: at + 48 * HOUR,
      resolutionDueMs: at + 120 * HOUR,
    });
    expect(slaDueTimes(at, "pro")).toEqual({
      firstResponseDueMs: at + 8 * HOUR,
      resolutionDueMs: at + 48 * HOUR,
    });
    expect(slaDueTimes(at, "business")).toEqual({
      firstResponseDueMs: at + 2 * HOUR,
      resolutionDueMs: at + 24 * HOUR,
    });
  });

  it("an unknown or mis-cased plan code is the free plan, never an error", () => {
    const at = utc("2026-05-01T09:00:00Z");
    expect(resolvePlan("platinum")).toBe("free");
    expect(resolvePlan("Pro")).toBe("free");
    expect(resolvePlan("")).toBe("free");
    expect(slaDueTimes(at, "platinum")).toEqual(slaDueTimes(at, "free"));
    expect(resolvePlan("business")).toBe("business");
  });

  it("rejects a non-integer clock value instead of producing a fractional due time", () => {
    expect(() => slaDueTimes(1.5, "pro")).toThrow(RangeError);
    expect(() => slaDueTimes(Number.NaN, "pro")).toThrow(RangeError);
  });
});

describe("SLA due times are UTC instants, so no offset or DST rule shifts them", () => {
  it("the same instant written with different offsets gives the same due times", () => {
    const instants = [
      "2026-03-07T17:00:00Z",
      "2026-03-07T12:00:00-05:00", // New York, before its spring-forward
      "2026-03-07T22:30:00+05:30", // Kolkata, same instant
      "2026-03-08T06:00:00+13:00", // Auckland (still NZDT in March), same instant
    ].map(utc);
    for (const at of instants) {
      expect(at).toBe(utc("2026-03-07T17:00:00Z"));
      expect(slaDueTimes(at, "free").firstResponseDueMs).toBe(utc("2026-03-09T17:00:00Z"));
      expect(slaDueTimes(at, "free").resolutionDueMs).toBe(utc("2026-03-12T17:00:00Z"));
    }
  });

  it("business 2h across the US spring-forward gap adds exactly 2 real hours", () => {
    // 2026-03-08 02:00 to 03:00 does not exist in New York. 01:30 EST plus two real hours is 04:30 EDT.
    const at = utc("2026-03-08T06:30:00Z");
    const due = slaDueTimes(at, "business");
    expect(due.firstResponseDueMs).toBe(utc("2026-03-08T08:30:00Z"));
    expect(due.firstResponseDueMs - at).toBe(2 * HOUR);
  });

  it("business 24h across the autumn fall-back spans 24 real hours, not 25 or 23", () => {
    // 2026-11-01 02:00 EDT becomes 01:00 EST (06:00Z). The window below crosses that change.
    const at = utc("2026-11-01T04:30:00Z"); // 00:30 EDT
    const due = slaDueTimes(at, "business");
    expect(due.resolutionDueMs - at).toBe(24 * HOUR);
    expect(new Date(due.resolutionDueMs).toISOString()).toBe("2026-11-02T04:30:00.000Z");
  });

  it("pro 48h across the Europe spring change adds 48 real hours", () => {
    const at = utc("2026-03-27T22:00:00Z");
    const due = slaDueTimes(at, "pro");
    expect(due.resolutionDueMs - at).toBe(48 * HOUR);
    expect(new Date(due.resolutionDueMs).toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("the due times do not depend on the process time zone", () => {
    // Pure arithmetic on epoch ms: the result is a fixed UTC string for every host TZ.
    const at = utc("2026-07-15T23:59:59Z");
    expect(new Date(slaDueTimes(at, "free").firstResponseDueMs).toISOString()).toBe(
      "2026-07-17T23:59:59.000Z",
    );
  });
});
