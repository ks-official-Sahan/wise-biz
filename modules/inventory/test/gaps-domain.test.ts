import { DomainError } from "@wise-biz/errors";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  assertGapTransition,
  assertResolution,
  GAP_STATUSES,
  GAP_TRANSITIONS,
  isGapCase,
} from "../src/domain/gap.ts";

const qty4 = fc.bigInt({ min: -9_999_999n, max: 9_999_999n });

describe("gap state machine", () => {
  const allowed = new Set(["open>investigating", "open>resolved", "investigating>resolved"]);

  it("allows exactly the documented transitions", () => {
    for (const from of GAP_STATUSES) {
      for (const to of GAP_STATUSES) {
        const ok = allowed.has(`${from}>${to}`);
        if (ok)
          expect(() => {
            assertGapTransition(from, to);
          }).not.toThrow();
        else
          expect(() => {
            assertGapTransition(from, to);
          }).toThrow(DomainError);
      }
    }
  });

  it("resolved is terminal", () => {
    expect(GAP_TRANSITIONS.resolved).toEqual([]);
  });
});

describe("isGapCase", () => {
  it("a zero variance is never a case, whatever the thresholds", () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 1000 }), { nil: undefined }),
        fc.option(fc.bigInt({ min: 0n, max: 1000n }), { nil: undefined }),
        fc.option(fc.integer({ min: -5, max: 5000 }), { nil: null }),
        (minValue, minQty, value) => {
          const t = { minQty4: minQty, minValueMinor: minValue ?? undefined };
          expect(isGapCase(0n, value, t)).toBe(false);
        },
      ),
    );
  });

  it("the qty threshold is strict: |variance| must be over it", () => {
    fc.assert(
      fc.property(
        qty4.filter((v) => v !== 0n),
        fc.bigInt({ min: 0n, max: 9_999_999n }),
        (v, min) => {
          const abs = v < 0n ? -v : v;
          expect(isGapCase(v, null, { minQty4: min })).toBe(abs > min);
        },
      ),
    );
  });

  it("an unknown value is a case under a value threshold (never silently small)", () => {
    expect(isGapCase(5n, null, { minValueMinor: 1_000_000 })).toBe(true);
    expect(isGapCase(5n, null, { minQty4: 100n })).toBe(false);
  });

  it("the value threshold is strict on the absolute value", () => {
    expect(isGapCase(5n, 500, { minValueMinor: 500 })).toBe(false);
    expect(isGapCase(5n, -501, { minValueMinor: 500 })).toBe(true);
  });

  it("either threshold selects the line", () => {
    expect(isGapCase(100n, 10, { minQty4: 50n, minValueMinor: 1000 })).toBe(true);
    expect(isGapCase(10n, 2000, { minQty4: 50n, minValueMinor: 1000 })).toBe(true);
    expect(isGapCase(10n, 10, { minQty4: 50n, minValueMinor: 1000 })).toBe(false);
  });
});

describe("assertResolution", () => {
  it("only misplaced-found takes a quantity, and only up to the shortage", () => {
    expect(() => {
      assertResolution("theft", -10n, null);
    }).not.toThrow();
    expect(() => {
      assertResolution("theft", -10n, 5n);
    }).toThrow(DomainError);
    expect(() => {
      assertResolution("misplaced_found", -10n, 10n);
    }).not.toThrow();
    expect(() => {
      assertResolution("misplaced_found", -10n, 11n);
    }).toThrow(DomainError);
    expect(() => {
      assertResolution("misplaced_found", -10n, null);
    }).toThrow(DomainError);
    expect(() => {
      assertResolution("misplaced_found", -10n, 0n);
    }).toThrow(DomainError);
  });

  it("misplaced-found needs a shortage, never an over", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 9_999_999n }),
        fc.bigInt({ min: 1n, max: 9_999_999n }),
        (v, f) => {
          const run = () => {
            assertResolution("misplaced_found", v, f);
          };
          expect(run).toThrow(DomainError);
        },
      ),
    );
  });
});
