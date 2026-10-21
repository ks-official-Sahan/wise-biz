import { describe, expect, it } from "vitest";

import { CurrencyMismatchError, MoneyArgumentError } from "./errors.ts";
import { money } from "./money.ts";
import { taxForLines, taxFromExclusive, taxFromInclusive } from "./tax.ts";

const usd = (n: number) => money(n, "USD");

describe("tax", () => {
  it("exclusive", () => {
    expect(taxFromExclusive(usd(1000), 1500)).toEqual(usd(150));
    expect(taxFromExclusive(usd(33), 500)).toEqual(usd(2)); // 1.65 -> 2
    expect(taxFromExclusive(usd(10), 1500, "down")).toEqual(usd(1));
  });

  it("inclusive splits exactly", () => {
    expect(taxFromInclusive(usd(1150), 1500)).toEqual({ net: usd(1000), tax: usd(150) });
    for (const gross of [1, 99, 1001, 12345, -777]) {
      const { net, tax } = taxFromInclusive(usd(gross), 1850);
      expect(net.minor + tax.minor).toBe(gross);
    }
    expect(taxFromInclusive(usd(100), 0).tax).toEqual(usd(0));
  });

  it("rejects bad rates", () => {
    expect(() => taxFromExclusive(usd(1), -1)).toThrow(MoneyArgumentError);
    expect(() => taxFromInclusive(usd(1), 1.5)).toThrow(MoneyArgumentError);
  });

  it("per-line vs per-document differ", () => {
    const lines = [usd(33), usd(33), usd(33)];
    const perLine = taxForLines(lines, 500, { inclusive: false, strategy: "per-line" });
    const perDoc = taxForLines(lines, 500, { inclusive: false, strategy: "per-document" });
    expect(perLine.total).toEqual(usd(6));
    expect(perDoc.total).toEqual(usd(5));
    expect(perDoc.lines.reduce((s, l) => s + l.minor, 0)).toBe(5);
    expect(perLine.lines.map((l) => l.minor)).toEqual([2, 2, 2]);
  });

  it("inclusive lines and explicit mode", () => {
    const r = taxForLines([usd(575), usd(575)], 1500, {
      inclusive: true,
      strategy: "per-document",
      mode: "half-up",
    });
    expect(r.total).toEqual(usd(150));
    expect(r.lines.map((l) => l.minor)).toEqual([75, 75]);
    const pl = taxForLines([usd(115)], 1500, { inclusive: true, strategy: "per-line" });
    expect(pl.total).toEqual(usd(15));
  });

  it("per-document with zero lines keeps zero tax", () => {
    const z = taxForLines([usd(0), usd(0)], 500, { inclusive: false, strategy: "per-document" });
    expect(z.lines).toEqual([usd(0), usd(0)]);
    expect(z.total).toEqual(usd(0));
  });

  it("mixed-sign document keeps line signs and sums to total", () => {
    const r = taxForLines([usd(1000), usd(-300)], 1500, {
      inclusive: false,
      strategy: "per-document",
    });
    expect(r.total).toEqual(usd(105));
    expect(r.lines.map((l) => l.minor)).toEqual([150, -45]);
    const odd = taxForLines([usd(1001), usd(-333), usd(7)], 1500, {
      inclusive: false,
      strategy: "per-document",
    });
    expect(odd.lines.reduce((s, l) => s + l.minor, 0)).toBe(odd.total.minor);
    expect(odd.lines[0]?.minor).toBeGreaterThan(0);
    expect(odd.lines[1]?.minor).toBeLessThanOrEqual(0);
  });

  it("zero-sum document has zero tax everywhere", () => {
    const r = taxForLines([usd(500), usd(-500)], 1500, {
      inclusive: false,
      strategy: "per-document",
    });
    expect(r.total).toEqual(usd(0));
    expect(r.lines.map((l) => l.minor)).toEqual([75, -75].map((n) => n)); // exact line taxes, offset
    expect(r.lines.reduce((s, l) => s + l.minor, 0)).toBe(0);
  });

  it("single line equals its own tax; diff spreads without flipping signs", () => {
    const one = taxForLines([usd(1150)], 1500, { inclusive: true, strategy: "per-document" });
    expect(one.lines).toEqual([usd(150)]);
    // lines whose tax rounds to 0 (1 * 5% = 0.05): the 1-unit diff lands on the largest remainder
    const small = taxForLines([usd(10), usd(10), usd(10)], 500, {
      inclusive: false,
      strategy: "per-document",
      mode: "down",
    });
    expect(small.total).toEqual(usd(1));
    expect(small.lines.map((l) => l.minor)).toEqual([1, 0, 0]);
    // zero line never takes the diff; tiny negative line cannot flip, positive takes it
    const guard = taxForLines([usd(30), usd(0)], 500, {
      inclusive: false,
      strategy: "per-document",
      mode: "up",
    });
    expect(guard.lines.reduce((s, l) => s + l.minor, 0)).toBe(guard.total.minor);
    expect(guard.lines[1]).toEqual(usd(0));
  });

  it("errors on empty or mixed currencies", () => {
    const opts = { inclusive: false, strategy: "per-line" } as const;
    expect(() => taxForLines([], 500, opts)).toThrow(MoneyArgumentError);
    expect(() => taxForLines([usd(1), money(1, "EUR")], 500, opts)).toThrow(CurrencyMismatchError);
  });
});
