import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { money, taxForLines, taxFromExclusive, taxFromInclusive } from "../../src/index.ts";

import type { RoundingMode, TaxStrategy } from "../../src/index.ts";

fc.configureGlobal({ seed: 42, numRuns: 500 });

const MODES: readonly RoundingMode[] = ["half-even", "half-up", "down", "up"];
const modeArb = fc.constantFrom(...MODES);
const rateArb = fc.integer({ min: 0, max: 50_000 });
const netArb = fc.integer({ min: 0, max: 10_000_000_000 });
const strategyArb = fc.constantFrom<TaxStrategy>("per-line", "per-document");
const signedLineArb = fc.integer({ min: -1_000_000_000, max: 1_000_000_000 });

describe("tax round-trip properties", () => {
  it("exclusive tax then inclusive split recovers the net within one minor unit", () => {
    fc.assert(
      fc.property(netArb, rateArb, modeArb, (minor, rate, mode) => {
        const net = money(minor, "USD");
        const gross = money(minor + taxFromExclusive(net, rate, mode).minor, "USD");
        const { net: backNet, tax: backTax } = taxFromInclusive(gross, rate, mode);
        expect(backNet.minor + backTax.minor).toBe(gross.minor);
        expect(Math.abs(backNet.minor - minor)).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("taxForLines properties", () => {
  it("per-line and per-document totals equal the sum of their line taxes", () => {
    fc.assert(
      fc.property(
        fc.array(signedLineArb, { minLength: 1, maxLength: 20 }),
        rateArb,
        fc.boolean(),
        strategyArb,
        modeArb,
        (amounts, rate, inclusive, strategy, mode) => {
          const lines = amounts.map((minor) => money(minor, "USD"));
          const result = taxForLines(lines, rate, { inclusive, strategy, mode });
          const lineSum = result.lines.reduce((acc, line) => acc + line.minor, 0);
          expect(lineSum).toBe(result.total.minor);
        },
      ),
    );
  });

  it("per-line tax has the same sign as its line or is zero", () => {
    fc.assert(
      fc.property(
        fc.array(signedLineArb, { minLength: 1, maxLength: 20 }),
        rateArb,
        fc.boolean(),
        modeArb,
        (amounts, rate, inclusive, mode) => {
          const lines = amounts.map((minor) => money(minor, "USD"));
          const result = taxForLines(lines, rate, { inclusive, strategy: "per-line", mode });
          lines.forEach((line, index) => {
            const tax = result.lines[index]?.minor ?? Number.NaN;
            expect(tax === 0 || Math.sign(tax) === Math.sign(line.minor)).toBe(true);
          });
        },
      ),
    );
  });

  // Expected to FAIL today: per-document allocates a document-level tax (sign of the net total)
  // back to lines by |line|, so a positive line can receive a negative tax when the document nets negative.
  it("per-document tax has the same sign as its line or is zero", () => {
    fc.assert(
      fc.property(
        fc.array(signedLineArb, { minLength: 1, maxLength: 20 }),
        rateArb,
        fc.boolean(),
        modeArb,
        (amounts, rate, inclusive, mode) => {
          const lines = amounts.map((minor) => money(minor, "USD"));
          const result = taxForLines(lines, rate, { inclusive, strategy: "per-document", mode });
          lines.forEach((line, index) => {
            const tax = result.lines[index]?.minor ?? Number.NaN;
            expect(tax === 0 || Math.sign(tax) === Math.sign(line.minor)).toBe(true);
          });
        },
      ),
    );
  });
});
