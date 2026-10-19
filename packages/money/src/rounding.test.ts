import { describe, expect, it } from "vitest";

import { MoneyArgumentError } from "./errors.ts";
import { money } from "./money.ts";
import { divRound, roundToIncrement } from "./rounding.ts";

import type { RoundingMode } from "./rounding.ts";

// numerator over 10 => value n/10
const table: readonly [number, Record<RoundingMode, bigint>][] = [
  [25, { "half-even": 2n, "half-up": 3n, down: 2n, up: 3n }],
  [35, { "half-even": 4n, "half-up": 4n, down: 3n, up: 4n }],
  [-25, { "half-even": -2n, "half-up": -3n, down: -2n, up: -3n }],
  [-35, { "half-even": -4n, "half-up": -4n, down: -3n, up: -4n }],
  [24, { "half-even": 2n, "half-up": 2n, down: 2n, up: 3n }],
  [26, { "half-even": 3n, "half-up": 3n, down: 2n, up: 3n }],
  [-24, { "half-even": -2n, "half-up": -2n, down: -2n, up: -3n }],
  [-26, { "half-even": -3n, "half-up": -3n, down: -2n, up: -3n }],
  [20, { "half-even": 2n, "half-up": 2n, down: 2n, up: 2n }],
];

describe("divRound", () => {
  for (const [n, expected] of table) {
    for (const mode of Object.keys(expected) as RoundingMode[]) {
      it(`${String(n)}/10 ${mode}`, () => {
        expect(divRound(n, 10, mode)).toBe(expected[mode]);
      });
    }
  }

  it("handles negative denominators and bigint", () => {
    expect(divRound(25, -10, "half-up")).toBe(-3n);
    expect(divRound(-25n, -10n, "half-even")).toBe(2n);
    expect(divRound(7n, 2n, "down")).toBe(3n);
  });

  it("rejects zero denominator and non-integers", () => {
    expect(() => divRound(1, 0, "down")).toThrow(MoneyArgumentError);
    expect(() => divRound(1.5, 2, "down")).toThrow(MoneyArgumentError);
  });
});

describe("roundToIncrement", () => {
  it.each([
    [1002, 1000],
    [1003, 1005],
    [1007, 1005],
    [1008, 1010],
    [-1003, -1005],
    [-1002, -1000],
    [1000, 1000],
    [1005, 1005],
  ])("0.05 half-up %i -> %i", (input, expected) => {
    expect(roundToIncrement(money(input, "USD"), 5).minor).toBe(expected);
  });

  it("supports other modes and tie behaviour", () => {
    expect(roundToIncrement(money(1003, "USD"), 5, "down").minor).toBe(1000);
    expect(roundToIncrement(money(1001, "USD"), 5, "up").minor).toBe(1005);
    expect(roundToIncrement(money(25, "USD"), 50, "half-even").minor).toBe(0);
    expect(roundToIncrement(money(25, "USD"), 50).minor).toBe(50);
  });

  it("rejects bad increments", () => {
    expect(() => roundToIncrement(money(1, "USD"), 0)).toThrow(MoneyArgumentError);
    expect(() => roundToIncrement(money(1, "USD"), 1.5)).toThrow(MoneyArgumentError);
  });
});
