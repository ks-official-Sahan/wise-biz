import { describe, expect, it } from "vitest";

import { CURRENCY_EXPONENTS, exponentOf, isCurrency, toCurrency } from "./currency.ts";
import { UnknownCurrencyError } from "./errors.ts";

describe("currency table", () => {
  it.each([
    ["JPY", 0],
    ["KPW", 2],
    ["KRW", 0],
    ["USD", 2],
    ["LKR", 2],
    ["EUR", 2],
    ["BHD", 3],
    ["KWD", 3],
    ["OMR", 3],
    ["JOD", 3],
    ["TND", 3],
    ["LYD", 3],
    ["IQD", 3],
    ["CLF", 4],
    ["UYW", 4],
  ])("%s has exponent %i", (code, exponent) => {
    expect(exponentOf(code)).toBe(exponent);
  });

  it("is frozen and only holds exponents 0/2/3/4", () => {
    expect(Object.isFrozen(CURRENCY_EXPONENTS)).toBe(true);
    for (const exponent of Object.values(CURRENCY_EXPONENTS))
      expect([0, 2, 3, 4]).toContain(exponent);
  });

  it("isCurrency is exact and prototype-safe", () => {
    expect(isCurrency("USD")).toBe(true);
    expect(isCurrency("usd")).toBe(false);
    expect(isCurrency("toString")).toBe(false);
  });

  it("exponentOf throws on unknown codes", () => {
    expect(() => exponentOf("XXX")).toThrow(UnknownCurrencyError);
    expect(() => exponentOf("constructor")).toThrow(UnknownCurrencyError);
  });

  it("toCurrency narrows or throws", () => {
    expect(toCurrency("USD")).toBe("USD");
    expect(() => toCurrency("usd")).toThrow(UnknownCurrencyError);
  });
});
