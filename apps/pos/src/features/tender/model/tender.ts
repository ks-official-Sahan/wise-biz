/** Tender arithmetic: remaining balance, cash with change, suggested amounts. Integer minor units only. */

export type TenderKind = "cash" | "card" | "voucher" | "store_credit";

export interface TenderEntry {
  readonly id: string;
  readonly kind: TenderKind;
  /** Applied to the sale (change already taken out). */
  readonly amountMinor: number;
  /** Cash handed over, for the drawer count. */
  readonly receivedMinor?: number;
  readonly changeMinor?: number;
  readonly card?: {
    readonly provider: string;
    readonly providerRef?: string;
    readonly authCode?: string;
    readonly last4?: string;
    readonly brand?: string;
  };
}

export const paid = (tenders: readonly TenderEntry[]): number =>
  tenders.reduce((n, t) => n + t.amountMinor, 0);

export const remaining = (payableMinor: number, tenders: readonly TenderEntry[]): number =>
  Math.max(0, payableMinor - paid(tenders));

/**
 * Cash handed over against what is still owed. Over-paying returns change; under-paying is a partial tender (split
 * payment) and returns none. Never negative, never more than owed.
 */
export function cashTender(
  remainingMinor: number,
  receivedMinor: number,
): {
  readonly amountMinor: number;
  readonly changeMinor: number;
} {
  const received = Math.max(0, Math.trunc(receivedMinor));
  const amountMinor = Math.min(received, remainingMinor);
  return { amountMinor, changeMinor: received - amountMinor };
}

/** Banknote and coin steps in major units, by currency; others use a decimal ladder. */
const NOTES: Readonly<Record<string, readonly number[]>> = {
  USD: [1, 5, 10, 20, 50, 100],
  EUR: [5, 10, 20, 50, 100, 200],
  GBP: [5, 10, 20, 50],
  LKR: [100, 500, 1000, 2000, 5000],
  INR: [10, 50, 100, 200, 500, 2000],
  JPY: [1000, 5000, 10000],
  KWD: [1, 5, 10, 20],
};
const DEFAULT_NOTES = [1, 5, 10, 20, 50, 100, 500, 1000];

/** Minor units per major unit (100 for USD, 1 for JPY, 1000 for KWD). */
export function minorPerMajor(currency: string): number {
  const digits =
    new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return 10 ** digits;
}

/** The exact amount first, then the next notes that cover it (each rounded up to a note step), at most `max`. */
export function suggestedAmounts(remainingMinor: number, currency: string, max = 4): number[] {
  if (remainingMinor <= 0) return [];
  const unit = minorPerMajor(currency);
  const out = new Set<number>([remainingMinor]);
  const steps = NOTES[currency] ?? DEFAULT_NOTES;
  for (const step of steps) {
    const note = step * unit;
    out.add(Math.ceil(remainingMinor / note) * note);
    if (out.size > max * 2) break;
  }
  return [...out].sort((a, b) => a - b).slice(0, max);
}

/** "19.85" -> 1985 in USD, "500" -> 500 in JPY. Undefined for text that is not an amount in this currency. */
export function parseMajor(text: string, currency: string): number | undefined {
  const digits = Math.round(Math.log10(minorPerMajor(currency)));
  const m = /^(\d{1,9})(?:\.(\d*))?$/.exec(text.trim());
  if (m === null) return undefined;
  const frac = m[2] ?? "";
  if (frac.length > digits) return undefined;
  return Number(m[1]) * minorPerMajor(currency) + Number(frac.padEnd(digits, "0") || "0");
}
