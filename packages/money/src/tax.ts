import { multiply, percent } from "./allocate.ts";
import { MoneyArgumentError } from "./errors.ts";
import { money, sub, sum } from "./money.ts";

import type { Money } from "./money.ts";
import type { RoundingMode } from "./rounding.ts";

export type TaxStrategy = "per-line" | "per-document";

function checkRate(rateBps: number): void {
  if (!Number.isSafeInteger(rateBps) || rateBps < 0) {
    throw new MoneyArgumentError("rateBps must be a non-negative integer");
  }
}

/** Tax amount on a tax-exclusive net. */
export function taxFromExclusive(
  net: Money,
  rateBps: number,
  mode: RoundingMode = "half-even",
): Money {
  checkRate(rateBps);
  return percent(net, rateBps, mode);
}

/** Split a tax-inclusive gross into net and tax; net + tax === gross exactly. */
export function taxFromInclusive(
  gross: Money,
  rateBps: number,
  mode: RoundingMode = "half-even",
): { net: Money; tax: Money } {
  checkRate(rateBps);
  const tax = multiply(gross, { num: rateBps, den: 10_000 + rateBps }, mode);
  return { net: sub(gross, tax), tax };
}

export type TaxLinesOptions = Readonly<{
  inclusive: boolean;
  strategy: TaxStrategy;
  mode?: RoundingMode;
}>;

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

/**
 * Tax per line plus total. per-document taxes the sum once, then spreads the rounding
 * difference (document tax - sum of line taxes) one minor unit at a time onto the lines
 * whose exact tax was rounded furthest the other way. Line taxes never change sign.
 */
export function taxForLines(
  lines: readonly Money[],
  rateBps: number,
  options: TaxLinesOptions,
): { lines: Money[]; total: Money } {
  const first = lines[0];
  if (first === undefined) throw new MoneyArgumentError("lines must not be empty");
  const { currency } = first;
  const mode = options.mode ?? "half-even";
  const taxOf = (m: Money): Money =>
    options.inclusive ? taxFromInclusive(m, rateBps, mode).tax : taxFromExclusive(m, rateBps, mode);

  const taxes = lines.map(taxOf);
  if (options.strategy === "per-line") return { lines: taxes, total: sum(taxes, currency) };

  const total = taxOf(sum(lines, currency));
  const diff = total.minor - sum(taxes, currency).minor;
  if (diff === 0) return { lines: taxes, total };

  const step = sign(diff);
  const den = BigInt(options.inclusive ? 10_000 + rateBps : 10_000);
  // residual = (exact - rounded) * den, exact integer; rounded never differs from exact by >= 1 unit
  const residual = lines.map(
    (line, i) => BigInt(line.minor) * BigInt(rateBps) - BigInt(taxes[i]?.minor ?? 0) * den,
  );
  const order = lines
    .map((_, index) => index)
    .sort((a, b) => {
      const ra = residual[a] ?? 0n;
      const rb = residual[b] ?? 0n;
      if (ra === rb) return a - b;
      return (ra > rb ? -1 : 1) * step;
    });
  const values = taxes.map((t) => t.minor);
  const canTake = (i: number): boolean => {
    const lineSign = sign(lines[i]?.minor ?? 0);
    return lineSign !== 0 && sign((values[i] ?? 0) + step) !== -lineSign;
  };
  let fallback = 0;
  lines.forEach((line, i) => {
    if (Math.abs(line.minor) > Math.abs(lines[fallback]?.minor ?? 0)) fallback = i;
  });
  const used = new Set<number>();
  for (let left = Math.abs(diff); left > 0; left -= 1) {
    let pick = order.find((i) => !used.has(i) && canTake(i));
    // defensive: |diff| never exceeds the line count in practice
    /* v8 ignore next */
    pick ??= order.find(canTake) ?? fallback;
    used.add(pick);
    values[pick] = (values[pick] ?? 0) + step;
  }
  return { lines: values.map((v) => money(v, currency)), total };
}
