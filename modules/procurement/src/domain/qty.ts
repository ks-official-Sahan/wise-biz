/**
 * Quantities: numeric(18,4) in Postgres, decimal strings on the wire, bigint ten-thousandths in TypeScript, so sums
 * and comparisons never touch floating point. Same wire format and scale as the inventory ledger; kept local because
 * modules never import each other's internals (AGENTS.md rule 9).
 */
const QTY = /^-?\d{1,14}(\.\d{1,4})?$/;
export const UNIT = 10_000n;

export function toQty4(s: string): bigint {
  if (!QTY.test(s)) throw new RangeError(`bad quantity "${s}"`);
  const neg = s.startsWith("-");
  const [int = "0", frac = ""] = (neg ? s.slice(1) : s).split(".");
  const v = BigInt(int) * UNIT + BigInt(frac.padEnd(4, "0"));
  return neg ? -v : v;
}

/** Shortest decimal string: 125000n -> "12.5", 0n -> "0". */
export function fromQty4(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = (a / UNIT).toString();
  const frac = (a % UNIT).toString().padStart(4, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac === "" ? "" : `.${frac}`}`;
}

/** numeric text from Postgres ("12.5000") -> canonical string ("12.5"). */
export const normQty = (pg: string): string => fromQty4(toQty4(pg));
