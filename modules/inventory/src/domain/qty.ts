/**
 * Quantities are numeric(18,4) in Postgres and decimal strings on the wire ("12.5", "-0.25"). In TypeScript they are
 * bigint ten-thousandths (qty4), so sums and comparisons never touch floating point.
 */
const QTY = /^-?\d{1,14}(\.\d{1,4})?$/;
export const UNIT = 10_000n;
/** "No batch" in stock_balances and reservations (keyed tables cannot hold NULL in a primary key). */
export const NO_BATCH = "00000000-0000-0000-0000-000000000000";

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

/** numeric text from Postgres ("12.5000") -> canonical string ("12.5"). */
export const normQty = (pg: string): string => fromQty4(toQty4(pg));

/** qty x unit price, rounded half away from zero to whole minor units (cost and value of a line). */
export function lineValueMinor(qty4: bigint, unitMinor: number): number {
  const n = (qty4 < 0n ? -qty4 : qty4) * BigInt(unitMinor);
  return Number((n + UNIT / 2n) / UNIT);
}
