import { describe, expect, it } from "vitest";

import { CurrencyMismatchError, MoneyOverflowError, UnknownCurrencyError } from "./errors.ts";
import {
  abs,
  add,
  compare,
  equals,
  fromBigint,
  isNegative,
  isZero,
  money,
  neg,
  sub,
  sum,
  zero,
} from "./money.ts";

const usd = (n: number) => money(n, "USD");

describe("money ops", () => {
  it("constructs frozen values and normalizes -0", () => {
    const m = usd(-0);
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.is(m.minor, 0)).toBe(true);
    expect(zero("JPY")).toEqual({ minor: 0, currency: "JPY" });
  });

  it("rejects unknown currency, fractions, NaN and unsafe integers", () => {
    expect(() => money(1, "XXX")).toThrow(UnknownCurrencyError);
    expect(() => usd(1.5)).toThrow(MoneyOverflowError);
    expect(() => usd(Number.NaN)).toThrow(MoneyOverflowError);
    expect(() => usd(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyOverflowError);
  });

  it("arithmetic", () => {
    expect(add(usd(150), usd(250))).toEqual(usd(400));
    expect(sub(usd(150), usd(250))).toEqual(usd(-100));
    expect(neg(usd(5))).toEqual(usd(-5));
    expect(abs(usd(-5))).toEqual(usd(5));
    expect(Object.isFrozen(add(usd(1), usd(1)))).toBe(true);
  });

  it("compare / equals / predicates", () => {
    expect(compare(usd(1), usd(2))).toBe(-1);
    expect(compare(usd(2), usd(1))).toBe(1);
    expect(compare(usd(2), usd(2))).toBe(0);
    expect(equals(usd(2), usd(2))).toBe(true);
    expect(equals(usd(2), usd(3))).toBe(false);
    expect(isZero(usd(0))).toBe(true);
    expect(isZero(usd(1))).toBe(false);
    expect(isNegative(usd(-1))).toBe(true);
    expect(isNegative(usd(1))).toBe(false);
  });

  it("sum, including empty", () => {
    expect(sum([usd(1), usd(2), usd(3)], "USD")).toEqual(usd(6));
    expect(sum([], "USD")).toEqual(usd(0));
  });

  it("currency mismatch carries expected/actual in every binary op", () => {
    const eur = money(1, "EUR");
    for (const op of [add, sub, compare, equals]) {
      try {
        op(usd(1), eur);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CurrencyMismatchError);
        expect((error as CurrencyMismatchError).expected).toBe("USD");
        expect((error as CurrencyMismatchError).actual).toBe("EUR");
      }
    }
    expect(() => sum([eur], "USD")).toThrow(CurrencyMismatchError);
  });

  it("overflow guard on results", () => {
    const max = usd(Number.MAX_SAFE_INTEGER);
    expect(() => add(max, usd(1))).toThrow(MoneyOverflowError);
    expect(() => sub(neg(max), usd(1))).toThrow(MoneyOverflowError);
    expect(() => fromBigint(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "USD")).toThrow(
      MoneyOverflowError,
    );
    expect(() => fromBigint(-BigInt(Number.MAX_SAFE_INTEGER) - 1n, "USD")).toThrow(
      MoneyOverflowError,
    );
    expect(fromBigint(5n, "USD")).toEqual(usd(5));
  });
});
