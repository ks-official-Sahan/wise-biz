/**
 * Quantities are numeric(18,4) in Postgres and decimal strings on the wire. In TypeScript they are bigint
 * ten-thousandths (qty4), so sums and "returned <= sold" checks never touch floating point.
 */
const QTY = /^-?\d{1,14}(\.\d{1,4})?$/;
const UNIT = 10_000n;

export function toQty4(s: string): bigint {
  if (!QTY.test(s)) throw new RangeError(`bad quantity "${s}"`);
  const neg = s.startsWith("-");
  const [int = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(int) * UNIT + BigInt(frac.padEnd(4, "0"));
  return neg ? -v : v;
}

/** Shortest decimal string: 125000n -> "12.5", -2500n -> "-0.25", 0n -> "0". */
export function fromQty4(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = (a / UNIT).toString();
  const frac = (a % UNIT).toString().padStart(4, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac === "" ? "" : `.${frac}`}`;
}

export const negate = (s: string): string => fromQty4(-toQty4(s));
