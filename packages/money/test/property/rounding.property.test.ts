import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { divRound } from "../../src/index.ts";

import type { RoundingMode } from "../../src/index.ts";

fc.configureGlobal({ seed: 42, numRuns: 500 });

const MODES: readonly RoundingMode[] = ["half-even", "half-up", "down", "up"];
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

const absBig = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * Reference rounding on exact bigint math. Rounds |n / d| then restores the sign.
 * Sign-symmetric modes (half-even, half-up) round ties away from zero or to even on the magnitude.
 */
function referenceDivRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
  const negative = n !== 0n && n < 0n !== d < 0n;
  const top = absBig(n);
  const bottom = absBig(d);
  const floor = top / bottom;
  const rest = top % bottom;
  let magnitude = floor;
  if (rest !== 0n) {
    const versusHalf = 2n * rest - bottom; // <0 below half, 0 exact tie, >0 above half
    if (mode === "up") magnitude = floor + 1n;
    else if (mode === "half-up") magnitude = versusHalf >= 0n ? floor + 1n : floor;
    else if (mode === "half-even") {
      if (versusHalf > 0n) magnitude = floor + 1n;
      else if (versusHalf === 0n) magnitude = floor % 2n === 0n ? floor : floor + 1n;
    }
  }
  return negative ? -magnitude : magnitude;
}

const numeratorArb = fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
const positiveDenArb = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const modeArb = fc.constantFrom(...MODES);

describe("divRound matches exact bigint reference", () => {
  it("agrees with the reference for random safe-integer numerators and positive denominators", () => {
    fc.assert(
      fc.property(numeratorArb, positiveDenArb, modeArb, (n, d, mode) => {
        expect(divRound(n, d, mode)).toBe(referenceDivRound(BigInt(n), BigInt(d), mode));
      }),
    );
  });

  it("agrees with the reference beyond the safe range when given bigints", () => {
    const bigArb = fc.bigInt({ min: -SAFE * SAFE, max: SAFE * SAFE });
    const bigDenArb = fc.bigInt({ min: 1n, max: SAFE * SAFE });
    fc.assert(
      fc.property(bigArb, bigDenArb, modeArb, (n, d, mode) => {
        expect(divRound(n, d, mode)).toBe(referenceDivRound(n, d, mode));
      }),
    );
  });

  it("negating the denominator negates the result in every mode", () => {
    fc.assert(
      fc.property(numeratorArb, positiveDenArb, modeArb, (n, d, mode) => {
        expect(divRound(n, -d, mode)).toBe(-divRound(n, d, mode));
      }),
    );
  });
});

describe("divRound explicit tie cases", () => {
  const cases: readonly { n: number; d: number; expected: Record<RoundingMode, number> }[] = [
    // +0.5, +2.5, +3.5 and their negatives, written as n / 2
    { n: 1, d: 2, expected: { "half-even": 0, "half-up": 1, down: 0, up: 1 } },
    { n: -1, d: 2, expected: { "half-even": 0, "half-up": -1, down: 0, up: -1 } },
    { n: 5, d: 2, expected: { "half-even": 2, "half-up": 3, down: 2, up: 3 } },
    { n: -5, d: 2, expected: { "half-even": -2, "half-up": -3, down: -2, up: -3 } },
    { n: 7, d: 2, expected: { "half-even": 4, "half-up": 4, down: 3, up: 4 } },
    { n: -7, d: 2, expected: { "half-even": -4, "half-up": -4, down: -3, up: -4 } },
  ];
  for (const { n, d, expected } of cases) {
    for (const mode of MODES) {
      it(`${String(n)}/${String(d)} rounds to ${String(expected[mode])} with ${mode}`, () => {
        expect(divRound(n, d, mode)).toBe(BigInt(expected[mode]));
      });
    }
  }
});
