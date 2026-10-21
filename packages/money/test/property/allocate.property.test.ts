import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { allocate, money, splitEvenly } from "../../src/index.ts";

fc.configureGlobal({ seed: 42, numRuns: 500 });

const MAX_AMOUNT = 1_000_000_000_000;
const amountArb = fc.integer({ min: -MAX_AMOUNT, max: MAX_AMOUNT });
const weightsArb = fc
  .array(fc.integer({ min: 0, max: 1_000_000_000 }), { minLength: 1, maxLength: 20 })
  .filter((weights) => weights.some((weight) => weight > 0));

const absBig = (value: bigint): bigint => (value < 0n ? -value : value);

describe("allocate properties", () => {
  it("parts sum exactly to the input amount", () => {
    fc.assert(
      fc.property(amountArb, weightsArb, (amount, weights) => {
        const parts = allocate(money(amount, "USD"), weights);
        expect(parts.reduce((acc, part) => acc + part.minor, 0)).toBe(amount);
      }),
    );
  });

  it("every part is within one minor unit of its exact proportional share", () => {
    fc.assert(
      fc.property(amountArb, weightsArb, (amount, weights) => {
        const parts = allocate(money(amount, "USD"), weights);
        const total = BigInt(weights.reduce((acc, weight) => acc + weight, 0));
        weights.forEach((weight, index) => {
          const part = BigInt(parts[index]?.minor ?? Number.NaN);
          // |part - amount * weight / total| < 1  <=>  |part * total - amount * weight| < total
          const deviation = absBig(part * total - BigInt(amount) * BigInt(weight));
          expect(deviation < total).toBe(true);
        });
      }),
    );
  });

  it("zero-weight parts are exactly zero", () => {
    fc.assert(
      fc.property(amountArb, weightsArb, (amount, weights) => {
        const parts = allocate(money(amount, "USD"), weights);
        weights.forEach((weight, index) => {
          if (weight === 0) expect(parts[index]?.minor).toBe(0);
        });
      }),
    );
  });

  it("is deterministic for the same input", () => {
    fc.assert(
      fc.property(amountArb, weightsArb, (amount, weights) => {
        const first = allocate(money(amount, "USD"), weights);
        const second = allocate(money(amount, "USD"), weights);
        expect(second).toEqual(first);
      }),
    );
  });
});

describe("splitEvenly properties", () => {
  it("parts sum to the amount and differ by at most one minor unit", () => {
    fc.assert(
      fc.property(amountArb, fc.integer({ min: 1, max: 50 }), (amount, count) => {
        const parts = splitEvenly(money(amount, "EUR"), count).map((part) => part.minor);
        expect(parts).toHaveLength(count);
        expect(parts.reduce((acc, part) => acc + part, 0)).toBe(amount);
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }),
    );
  });
});
