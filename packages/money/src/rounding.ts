import { MoneyArgumentError } from "./errors.ts";
import { fromBigint } from "./money.ts";

import type { Money } from "./money.ts";

/** half-up/up round away from zero; down rounds toward zero. */
export type RoundingMode = "half-even" | "half-up" | "down" | "up";

function toBig(value: bigint | number, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) throw new MoneyArgumentError(`${label} must be a safe integer`);
  return BigInt(value);
}

/** Exact integer division of numerator by denominator with the given rounding mode. */
export function divRound(
  numerator: bigint | number,
  denominator: bigint | number,
  mode: RoundingMode,
): bigint {
  const n = toBig(numerator, "numerator");
  const d = toBig(denominator, "denominator");
  if (d === 0n) throw new MoneyArgumentError("denominator must not be zero");
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const step = n < 0n !== d < 0n ? -1n : 1n;
  const twice = (r < 0n ? -r : r) * 2n;
  const absD = d < 0n ? -d : d;
  switch (mode) {
    case "down":
      return q;
    case "up":
      return q + step;
    case "half-up":
      return twice >= absD ? q + step : q;
    case "half-even":
      if (twice > absD) return q + step;
      if (twice < absD) return q;
      return q % 2n === 0n ? q : q + step;
  }
}

/** Round to a multiple of `incrementMinor` (e.g. 5 for 0.05 cash rounding). */
export function roundToIncrement(
  m: Money,
  incrementMinor: number,
  mode: RoundingMode = "half-up",
): Money {
  if (!Number.isSafeInteger(incrementMinor) || incrementMinor <= 0) {
    throw new MoneyArgumentError("increment must be a positive safe integer");
  }
  return fromBigint(divRound(m.minor, incrementMinor, mode) * BigInt(incrementMinor), m.currency);
}
