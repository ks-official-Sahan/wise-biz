import { describe, expect, it } from "vitest";

import { allocate, multiply, percent, splitEvenly } from "./allocate.ts";
import { MoneyArgumentError, MoneyOverflowError } from "./errors.ts";
import { money } from "./money.ts";

const usd = (n: number) => money(n, "USD");
const minors = (list: { minor: number }[]) => list.map((m) => m.minor);

describe("multiply / percent", () => {
  it("integer and ratio factors with rounding", () => {
    expect(multiply(usd(250), 3)).toEqual(usd(750));
    expect(multiply(usd(5), { num: 1, den: 2 })).toEqual(usd(2)); // 2.5 half-even
    expect(multiply(usd(5), { num: 1, den: 2 }, "half-up")).toEqual(usd(3));
    expect(multiply(usd(-5), { num: 1, den: 2 }, "half-up")).toEqual(usd(-3));
    expect(multiply(usd(7), { num: 1, den: 2 }, "down")).toEqual(usd(3));
  });

  it("percent in bps", () => {
    expect(percent(usd(1000), 1500)).toEqual(usd(150));
    expect(percent(usd(1), 5000, "up")).toEqual(usd(1));
  });

  it("uses bigint for products beyond 2^53", () => {
    const big = usd(9_000_000_000_000_000);
    expect(multiply(big, { num: 9_000_000_000_000_000, den: 9_000_000_000_000_000 })).toEqual(big);
    expect(() => multiply(big, 2)).toThrow(MoneyOverflowError);
  });

  it("rejects bad ratios", () => {
    expect(() => multiply(usd(1), 1.5)).toThrow(MoneyArgumentError);
    expect(() => multiply(usd(1), { num: 1, den: 0 })).toThrow(MoneyArgumentError);
    expect(() => multiply(usd(1), { num: 1, den: 1.5 })).toThrow(MoneyArgumentError);
  });
});

describe("allocate", () => {
  it.each([
    [100, [1, 1, 1], [34, 33, 33]],
    [-100, [1, 1, 1], [-34, -33, -33]],
    [100, [0, 1, 1], [0, 50, 50]],
    [5, [1, 0, 1], [3, 0, 2]],
    [0, [1, 2], [0, 0]],
    [10, [70, 30], [7, 3]],
    [1, [1, 1], [1, 0]],
    [100, [3, 1], [75, 25]],
    [101, [2, 1, 1], [51, 25, 25]],
  ])("allocate(%i, %j) -> %j", (amount, weights, expected) => {
    const parts = allocate(usd(amount), weights);
    expect(minors(parts)).toEqual(expected);
    expect(parts.reduce((s, p) => s + p.minor, 0)).toBe(amount);
  });

  it("largest remainder beats index order", () => {
    // 10 over [1,1,2]*: shares 2.5,2.5,5 -> ties by index
    expect(minors(allocate(usd(10), [1, 1, 2]))).toEqual([3, 2, 5]);
    // 10 over [4,5,1]: 4,5,1 exact; 7 over [1,3,3]: 1,3,3 exact
    expect(minors(allocate(usd(2), [1, 3, 3]))).toEqual([0, 1, 1]);
  });

  it("error cases", () => {
    expect(() => allocate(usd(1), [])).toThrow(MoneyArgumentError);
    expect(() => allocate(usd(1), [0, 0])).toThrow(MoneyArgumentError);
    expect(() => allocate(usd(1), [-1, 2])).toThrow(MoneyArgumentError);
    expect(() => allocate(usd(1), [1.5])).toThrow(MoneyArgumentError);
  });

  it("handles huge amounts exactly", () => {
    const parts = allocate(usd(Number.MAX_SAFE_INTEGER), [1, 1, 1]);
    expect(parts.reduce((s, p) => s + BigInt(p.minor), 0n)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });
});

describe("splitEvenly", () => {
  it("splits with remainder to first", () => {
    expect(minors(splitEvenly(usd(100), 3))).toEqual([34, 33, 33]);
    expect(minors(splitEvenly(usd(-1), 2))).toEqual([-1, 0]);
  });

  it("rejects bad n", () => {
    expect(() => splitEvenly(usd(1), 0)).toThrow(MoneyArgumentError);
    expect(() => splitEvenly(usd(1), 1.5)).toThrow(MoneyArgumentError);
  });
});
