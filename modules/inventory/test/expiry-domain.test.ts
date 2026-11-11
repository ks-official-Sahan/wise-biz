import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { daysBetween, suggestMarkdownPercent, utcDate } from "../src/domain/expiry.ts";
import { fefoCompliance } from "../src/domain/fefo.ts";
import { UNIT } from "../src/domain/qty.ts";

/** Units to qty4 (the rule is scale-free, so tests speak in whole units). */
const u = (n: number): bigint => BigInt(n) * UNIT;
const ms = (iso: string): number => Date.parse(iso);

describe("suggestMarkdownPercent: rule table", () => {
  // Sales: 280 units in the 28-day window = 10 a day. Stock ahead in units.
  const sold = u(280);
  const cases: [
    name: string,
    daysLeft: number,
    stockAhead: number,
    sold4: bigint,
    percent: number,
  ][] = [
    ["expired: no markdown (write it off)", -1, 100, sold, 0],
    ["no stock ahead: nothing to mark down", 5, 0, sold, 0],
    ["band 30, cover 2x days left (r = 2): half factor", 5, 100, sold, 15],
    ["band 30, cover under days left (r < 1): sells through", 5, 40, sold, 0],
    ["band 30, cover 4x days left (r = 4): full factor", 5, 200, sold, 30],
    ["band 30, cover over 4x days left: 1.5 factor", 5, 300, sold, 45],
    ["band 10 (21 to 30 days left), cover under days left", 20, 100, sold, 0],
    ["band 10, cover 1.8x days left", 20, 500, sold, 10],
    ["beyond 30 days: outside the horizon", 40, 500, sold, 0],
    ["band 20 (8 to 14 days), r = 1 exactly sells through", 10, 100, sold, 0],
    ["band 20, r = 1.5: half factor", 10, 150, sold, 10],
    ["band 20, r = 3: full factor", 10, 300, sold, 20],
    ["no sales in the window, expiring today: capped at 50", 0, 10, u(0), 50],
    ["no sales, 2 days left: 40 x 1.5 capped at 50", 2, 10, u(0), 50],
    ["band 30 with no sales and 6 days left: 30 x 1.5", 6, 20, u(0), 45],
  ];
  it.each(cases)("%s", (_name, daysLeft, stock, sold4, percent) => {
    expect(suggestMarkdownPercent({ daysLeft, stockAhead4: u(stock), sold4 })).toBe(percent);
  });

  it("never returns more than the cap", () => {
    expect(
      suggestMarkdownPercent({ daysLeft: 0, stockAhead4: u(1), sold4: 0n }),
    ).toBeLessThanOrEqual(50);
  });
});

describe("suggestMarkdownPercent: properties", () => {
  const days = fc.integer({ min: -5, max: 400 });
  const qty = fc.bigInt({ min: 0n, max: 1_000_000_000n });

  it("is always in 0..50 and a multiple of 5", () => {
    fc.assert(
      fc.property(days, qty, qty, (daysLeft, stockAhead4, sold4) => {
        const p = suggestMarkdownPercent({ daysLeft, stockAhead4, sold4 });
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(50);
        expect(p % 5).toBe(0);
      }),
    );
  });

  it("more days left never raises the markdown", () => {
    fc.assert(
      fc.property(days, qty, qty, (daysLeft, stockAhead4, sold4) => {
        const near = suggestMarkdownPercent({ daysLeft, stockAhead4, sold4 });
        const later = suggestMarkdownPercent({ daysLeft: daysLeft + 1, stockAhead4, sold4 });
        if (daysLeft >= 0) expect(later).toBeLessThanOrEqual(near);
      }),
    );
  });

  it("more stock ahead never lowers the markdown", () => {
    fc.assert(
      fc.property(days, qty, qty, (daysLeft, stockAhead4, sold4) => {
        const less = suggestMarkdownPercent({ daysLeft, stockAhead4, sold4 });
        const more = suggestMarkdownPercent({ daysLeft, stockAhead4: stockAhead4 + UNIT, sold4 });
        expect(more).toBeGreaterThanOrEqual(less);
      }),
    );
  });

  it("more sales in the window never raises the markdown", () => {
    fc.assert(
      fc.property(days, qty, qty, (daysLeft, stockAhead4, sold4) => {
        const slow = suggestMarkdownPercent({ daysLeft, stockAhead4, sold4 });
        const fast = suggestMarkdownPercent({ daysLeft, stockAhead4, sold4: sold4 + UNIT });
        expect(fast).toBeLessThanOrEqual(slow);
      }),
    );
  });
});

describe("date helpers", () => {
  it("counts whole UTC days", () => {
    expect(daysBetween("2026-11-11", "2026-11-18")).toBe(7);
    expect(daysBetween("2026-11-11", "2026-11-01")).toBe(-10);
    expect(daysBetween("2026-11-11", "2026-11-11")).toBe(0);
  });

  it("uses the UTC calendar date of an instant", () => {
    expect(utcDate(ms("2026-11-11T23:59:59Z"))).toBe("2026-11-11");
    expect(utcDate(ms("2026-11-12T00:00:00Z"))).toBe("2026-11-12");
  });
});

describe("fefoCompliance", () => {
  const LOC = "00000000-0000-7000-8000-00000000000a";
  const OTHER_LOC = "00000000-0000-7000-8000-00000000000b";
  const V = "00000000-0000-7000-8000-0000000000c1";
  const B1 = "00000000-0000-7000-8000-0000000000b1";
  const B2 = "00000000-0000-7000-8000-0000000000b2";
  const B3 = "00000000-0000-7000-8000-0000000000b3";
  const from = ms("2026-10-01T00:00:00Z");
  const to = ms("2026-11-01T00:00:00Z");
  const t1 = ms("2026-10-10T10:00:00Z");
  const t2 = ms("2026-10-20T10:00:00Z");

  const batch = (
    batchId: string,
    expiresOn: string | null,
    currentQty4: bigint,
    locationId = LOC,
  ) => ({
    locationId,
    variantId: V,
    batchId,
    expiresOn,
    currentQty4,
  });
  const mv = (batchId: string, occurredAt: number, qty4: bigint, locationId = LOC) => ({
    locationId,
    variantId: V,
    batchId,
    occurredAt,
    qty4,
  });
  const out = (batchId: string, occurredAt: number, expiresOn: string | null, qty4: bigint) => ({
    ...mv(batchId, occurredAt, qty4),
    expiresOn,
  });
  const run = (
    outflows: ReturnType<typeof out>[],
    batches: ReturnType<typeof batch>[],
    movements: ReturnType<typeof mv>[],
  ) => fefoCompliance({ fromMs: from, toMs: to, outflows, batches, movements });

  it("a sale from the later batch while the earlier one still holds stock is a violation", () => {
    const rows = run(
      [out(B2, t1, "2026-10-31", u(-3))],
      [batch(B1, "2026-10-20", u(5)), batch(B2, "2026-10-31", u(7))],
      [mv(B2, t1, u(-3))],
    );
    expect(rows).toEqual([{ variantId: V, outflows: 1, violations: 1, violatedQty4: u(3) }]);
  });

  it("the earlier batch drained by the same instant (spill-over) is not a violation", () => {
    const rows = run(
      [out(B2, t1, "2026-10-31", u(-3))],
      [batch(B1, "2026-10-20", u(0)), batch(B2, "2026-10-31", u(7))],
      [mv(B1, t1, u(-5)), mv(B2, t1, u(-3))],
    );
    expect(rows[0]?.violations).toBe(0);
  });

  it("an earlier batch sold out before the sale is not a violation", () => {
    const rows = run(
      [out(B2, t2, "2026-10-31", u(-1))],
      [batch(B1, "2026-10-20", u(0)), batch(B2, "2026-10-31", u(9))],
      [mv(B1, t1, u(-5)), mv(B2, t2, u(-1))],
    );
    expect(rows[0]?.violations).toBe(0);
  });

  it("the balance is rebuilt at the sale instant: stock sold later still counts as held then", () => {
    // B1 held 5 on t2 (sold on day 25, after the sale on day 20): a violation at t2.
    const rows = run(
      [out(B2, t2, "2026-10-31", u(-1))],
      [batch(B1, "2026-10-20", u(0)), batch(B2, "2026-10-31", u(9))],
      [mv(B1, t1, u(5)), mv(B1, ms("2026-10-25T10:00:00Z"), u(-5)), mv(B2, t2, u(-1))],
    );
    expect(rows[0]?.violations).toBe(1);
  });

  it("an earlier batch that had expired on the sale date is skipped, like FEFO does", () => {
    const rows = run(
      [out(B2, t2, "2026-10-31", u(-1))],
      [batch(B1, "2026-10-15", u(5)), batch(B2, "2026-10-31", u(9))],
      [mv(B1, ms("2026-10-01T10:00:00Z"), u(5)), mv(B2, t2, u(-1))],
    );
    expect(rows[0]?.violations).toBe(0);
  });

  it("a batch without expiry sorts last: consuming it while a dated batch holds stock is a violation", () => {
    const rows = run(
      [out(B2, t2, null, u(-2))],
      [batch(B1, "2026-10-31", u(4)), batch(B2, null, u(8))],
      [mv(B2, t2, u(-2))],
    );
    expect(rows[0]?.violations).toBe(1);
  });

  it("the same expiry date is not earlier: no violation", () => {
    const rows = run(
      [out(B2, t2, "2026-10-31", u(-2))],
      [batch(B1, "2026-10-31", u(4)), batch(B2, "2026-10-31", u(8))],
      [mv(B2, t2, u(-2))],
    );
    expect(rows[0]?.violations).toBe(0);
  });

  it("other locations never count, and write-offs are not outflows (only consumption rows are passed)", () => {
    const rows = run(
      [out(B2, t2, "2026-10-31", u(-2))],
      [batch(B1, "2026-10-20", u(4), OTHER_LOC), batch(B2, "2026-10-31", u(8))],
      [mv(B1, t1, u(4), OTHER_LOC), mv(B2, t2, u(-2))],
    );
    expect(rows[0]?.violations).toBe(0);
  });

  it("only outflows inside [from, to) are judged; the batch set does not invent rows", () => {
    const outside = out(B2, ms("2026-12-05T00:00:00Z"), "2026-12-31", u(-2));
    const rows = run([outside], [batch(B1, "2026-11-20", u(4)), batch(B2, "2026-12-31", u(8))], []);
    expect(rows).toEqual([]);
  });

  it("counts per variant, sorted by variant id", () => {
    const rows = run(
      [out(B2, t2, "2026-10-31", u(-2)), out(B2, t1, "2026-10-31", u(-1))],
      [batch(B1, "2026-10-20", u(4)), batch(B2, "2026-10-31", u(8)), batch(B3, "2026-10-20", u(0))],
      [mv(B2, t1, u(-1)), mv(B2, t2, u(-2))],
    );
    expect(rows).toEqual([{ variantId: V, outflows: 2, violations: 2, violatedQty4: u(3) }]);
  });
});
