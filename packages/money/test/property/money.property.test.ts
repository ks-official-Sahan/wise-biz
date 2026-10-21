import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CurrencyMismatchError, add, compare, equals, money, sub } from "../../src/index.ts";

import type { Money } from "../../src/index.ts";

fc.configureGlobal({ seed: 42, numRuns: 500 });

const MAX_AMOUNT = 1_000_000_000_000;
const CURRENCIES = ["USD", "EUR", "JPY", "BHD"] as const;
const amountArb = fc.integer({ min: -MAX_AMOUNT, max: MAX_AMOUNT });
const currencyArb = fc.constantFrom(...CURRENCIES);
const moneyArb = fc.tuple(amountArb, currencyArb).map(([minor, code]) => money(minor, code));

const distinctPairArb = fc.tuple(currencyArb, currencyArb).filter(([a, b]) => a !== b);

describe("add / sub properties", () => {
  it("add is commutative within the safe range", () => {
    fc.assert(
      fc.property(amountArb, amountArb, (x, y) => {
        expect(add(money(x, "USD"), money(y, "USD")).minor).toBe(
          add(money(y, "USD"), money(x, "USD")).minor,
        );
      }),
    );
  });

  it("add is associative within the safe range", () => {
    fc.assert(
      fc.property(amountArb, amountArb, amountArb, (x, y, z) => {
        const a = money(x, "USD");
        const b = money(y, "USD");
        const c = money(z, "USD");
        expect(add(add(a, b), c)).toEqual(add(a, add(b, c)));
      }),
    );
  });

  it("sub(add(a, b), b) returns a", () => {
    fc.assert(
      fc.property(moneyArb, amountArb, (a: Money, y) => {
        const b = money(y, a.currency);
        expect(equals(sub(add(a, b), b), a)).toBe(true);
      }),
    );
  });

  it("mismatched currencies always throw CurrencyMismatchError", () => {
    fc.assert(
      fc.property(amountArb, amountArb, distinctPairArb, (x, y, [ca, cb]) => {
        const a = money(x, ca);
        const b = money(y, cb);
        expect(() => add(a, b)).toThrow(CurrencyMismatchError);
        expect(() => sub(a, b)).toThrow(CurrencyMismatchError);
        expect(() => compare(a, b)).toThrow(CurrencyMismatchError);
        expect(() => equals(a, b)).toThrow(CurrencyMismatchError);
      }),
    );
  });
});
