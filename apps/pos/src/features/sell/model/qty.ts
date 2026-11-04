/** Quantities are decimal text with up to 4 places ("2", "1.25"); arithmetic is on ten-thousandths, never floats. */
const SCALE = 10_000;
const QTY = /^\d{1,9}(\.\d{1,4})?$/;

export function toQty4(qty: string): number | undefined {
  if (!QTY.test(qty)) return undefined;
  const [whole = "0", frac = ""] = qty.split(".");
  return Number(whole) * SCALE + Number(frac.padEnd(4, "0"));
}

export function fromQty4(q4: number): string {
  const whole = Math.trunc(q4 / SCALE);
  const frac = String(q4 % SCALE)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return frac === "" ? String(whole) : `${String(whole)}.${frac}`;
}

/** a + b as text, or undefined when either is not a valid quantity or the sum would leave the safe range. */
export function addQty(a: string, b: string): string | undefined {
  const x = toQty4(a);
  const y = toQty4(b);
  if (x === undefined || y === undefined) return undefined;
  const sum = x + y;
  return sum > 999_999_999 * SCALE ? undefined : fromQty4(sum);
}

/** Whole-number view for the stepper (weighed lines keep their decimal quantity and are edited on the keypad). */
export function isWhole(qty: string): boolean {
  const q = toQty4(qty);
  return q !== undefined && q % SCALE === 0;
}
