import { DomainError } from "@wise-biz/errors";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertApprovable,
  assertCountTransition,
  COUNT_STATUSES,
  COUNT_TRANSITIONS,
  expectedAtClose,
  valueMinor,
  varianceOf,
  type CountStatus,
} from "../src/domain/count.ts";
import { toQty4 } from "../src/domain/qty.ts";

const qty4 = fc.bigInt({ min: -9_999_999n, max: 9_999_999n });

describe("count state machine", () => {
  const allowed = new Set([
    "draft>open",
    "draft>cancelled",
    "open>review",
    "open>cancelled",
    "review>open",
    "review>approved",
    "review>cancelled",
  ]);

  it("allows exactly the documented transitions", () => {
    for (const from of COUNT_STATUSES) {
      for (const to of COUNT_STATUSES) {
        if (allowed.has(`${from}>${to}`)) {
          expect(() => {
            assertCountTransition(from, to);
          }).not.toThrow();
        } else {
          expect(() => {
            assertCountTransition(from, to);
          }).toThrow(DomainError);
        }
      }
    }
  });

  it("approved and cancelled are terminal; random walks never reach an illegal state", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...COUNT_STATUSES), { minLength: 1, maxLength: 25 }),
        (targets) => {
          let at: CountStatus = "draft";
          for (const to of targets) {
            if (COUNT_TRANSITIONS[at].includes(to)) {
              at = to;
            } else {
              expect(() => {
                assertCountTransition(at, to);
              }).toThrow(DomainError);
            }
          }
          if (at === "approved" || at === "cancelled") {
            expect(COUNT_TRANSITIONS[at]).toHaveLength(0);
          }
        },
      ),
    );
  });
});

describe("expected quantity and variance", () => {
  it("live counts measure against the close cut, frozen counts against the snapshot", () => {
    expect(expectedAtClose("live", 100_000n, 120_000n)).toBe(120_000n);
    expect(expectedAtClose("frozen", 100_000n, 100_000n)).toBe(100_000n);
  });

  it("variance is counted minus expected, exact in ten-thousandths", () => {
    expect(varianceOf(95_000n, 100_000n)).toBe(-5_000n);
    expect(varianceOf(100_001n, 100_000n)).toBe(1n);
  });

  it("property: counted = expected + variance for any values", () => {
    fc.assert(
      fc.property(qty4, qty4, (counted, expected) => {
        expect(expected + varianceOf(counted, expected)).toBe(counted);
      }),
    );
  });
});

describe("value impact (integer minor units)", () => {
  it("unknown cost is null, never 0", () => {
    expect(valueMinor(toQty4("3"), null, "USD")).toBeNull();
  });

  it("values a whole and a fractional quantity at the unit cost", () => {
    expect(valueMinor(toQty4("3"), 250, "USD")).toBe(750);
    expect(valueMinor(toQty4("-2"), 250, "USD")).toBe(-500);
    expect(valueMinor(toQty4("0"), 250, "USD")).toBe(0);
  });

  it("rounds half away from zero on the minor unit (1.5 x 333 = 499.5 -> 500)", () => {
    expect(valueMinor(toQty4("1.5"), 333, "USD")).toBe(500);
    expect(valueMinor(toQty4("-1.5"), 333, "USD")).toBe(-500);
  });

  it("property: the value has the sign of the variance and never exceeds the exact product", () => {
    fc.assert(
      fc.property(qty4, fc.integer({ min: 0, max: 1_000_000 }), (v, cost) => {
        const val = valueMinor(v, cost, "USD");
        if (val === null) throw new Error("known cost must value");
        if (v > 0n) expect(val).toBeGreaterThanOrEqual(0);
        if (v < 0n) expect(val).toBeLessThanOrEqual(0);
        const exact = (Number(v) * cost) / 10_000;
        expect(Math.abs(val - exact)).toBeLessThanOrEqual(0.5 + 1e-9);
      }),
    );
  });
});

describe("approval gate", () => {
  const line = (counted: string | null, snapshot: string, close: string | null) => ({
    counted4: counted === null ? null : toQty4(counted),
    snapshot4: toQty4(snapshot),
    close4: close === null ? null : toQty4(close),
  });

  it("refuses uncounted lines", () => {
    expect(() => {
      assertApprovable("live", [line("1", "1", "1"), line(null, "2", "2")]);
    }).toThrow(/1 line\(s\) are not counted/);
  });

  it("refuses a frozen count whose stock moved during the window", () => {
    expect(() => {
      assertApprovable("frozen", [line("9", "10", "9")]);
    }).toThrow(/Stock moved during a frozen count/);
  });

  it("accepts a live count whose stock moved (the movement is part of the expectation)", () => {
    expect(() => {
      assertApprovable("live", [line("9", "10", "9")]);
    }).not.toThrow();
  });
});

describe("ledger after approval (property)", () => {
  // Model: stock at the snapshot, moves while counting (sales and receipts, possibly driving stock negative),
  // then moves after the close (sales during review). The physical count reads what is on hand at the close.
  it("ledger = counted + post-close moves for live counts, for any moves", () => {
    fc.assert(
      fc.property(
        qty4,
        fc.array(qty4, { maxLength: 8 }),
        fc.array(qty4, { maxLength: 8 }),
        qty4,
        (snapshot, window, post, shelfError) => {
          const close = window.reduce((a, m) => a + m, snapshot);
          // The shelf is what the counter found at close: the true stock plus whatever the count got wrong.
          const counted = close + shelfError;
          const variance = varianceOf(counted, expectedAtClose("live", snapshot, close));
          const postSum = post.reduce((a, m) => a + m, 0n);
          const ledgerAfter = close + postSum + variance;
          expect(ledgerAfter - postSum).toBe(counted);
        },
      ),
    );
  });
});
