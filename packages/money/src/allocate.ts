import { MoneyArgumentError } from "./errors.ts";
import { fromBigint } from "./money.ts";
import { divRound } from "./rounding.ts";

import type { Money } from "./money.ts";
import type { RoundingMode } from "./rounding.ts";

export type Ratio = Readonly<{ num: number; den: number }>;

export function multiply(m: Money, ratio: Ratio | number, mode: RoundingMode = "half-even"): Money {
  const { num, den } = typeof ratio === "number" ? { num: ratio, den: 1 } : ratio;
  if (!Number.isSafeInteger(num))
    throw new MoneyArgumentError("ratio numerator must be an integer");
  if (!Number.isSafeInteger(den) || den <= 0) {
    throw new MoneyArgumentError("ratio denominator must be a positive integer");
  }
  return fromBigint(divRound(BigInt(m.minor) * BigInt(num), den, mode), m.currency);
}

/** Basis points: 10_000 bps = 100%. */
export function percent(m: Money, bps: number, mode: RoundingMode = "half-even"): Money {
  return multiply(m, { num: bps, den: 10_000 }, mode);
}

/** Largest-remainder split; ties go to the lower index; parts sum exactly to `m`. */
export function allocate(m: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new MoneyArgumentError("weights must not be empty");
  let total = 0n;
  const w: bigint[] = [];
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new MoneyArgumentError("weights must be non-negative safe integers");
    }
    w.push(BigInt(weight));
    total += BigInt(weight);
  }
  if (total === 0n) throw new MoneyArgumentError("at least one weight must be positive");

  const negative = m.minor < 0;
  const amount = BigInt(Math.abs(m.minor));
  const shares: bigint[] = [];
  const remainders: bigint[] = [];
  let assigned = 0n;
  for (const weight of w) {
    const product = amount * weight;
    const share = product / total;
    shares.push(share);
    remainders.push(product % total);
    assigned += share;
  }
  let leftover = Number(amount - assigned);
  const order = remainders
    .map((rem, index) => ({ rem, index }))
    .sort((x, y) => (x.rem === y.rem ? x.index - y.index : x.rem > y.rem ? -1 : 1));
  for (const { index } of order) {
    if (leftover === 0) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    leftover -= 1;
  }
  return shares.map((share) => fromBigint(negative ? -share : share, m.currency));
}

export function splitEvenly(m: Money, n: number): Money[] {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new MoneyArgumentError("n must be a positive integer");
  return allocate(m, new Array<number>(n).fill(1));
}
