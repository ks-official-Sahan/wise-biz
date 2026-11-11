/**
 * Expiry rules (P2-04c). Pure: no I/O, no clock. Days are whole UTC days between two `YYYY-MM-DD` dates.
 *
 * Markdown rule (`suggestMarkdownPercent`). Inputs: days left, stock ahead (this batch plus every same-variant batch at
 * the location that expires no later, because FEFO sells those first) and the variant's sales at the location over the
 * last MARKDOWN_WINDOW_DAYS days. Output: a whole percent in 0..MARKDOWN_CAP_PERCENT, a multiple of 5.
 *   1. Expired (daysLeft < 0): 0. Expired stock is written off, never marked down.
 *   2. Urgency band by days left: <=3 days 40, <=7 days 30, <=14 days 20, <=30 days 10, more than 30 days 0.
 *   3. Cover ratio r = (stock ahead / daily sales) / days left. At r <= 1 the stock sells through in time: factor 0.
 *      1 < r <= 2: factor 0.5. 2 < r <= 4: factor 1. r > 4, or no sales in the window: factor 1.5.
 *   4. percent = min(50, round down to a multiple of 5 of band x factor).
 * Comparisons use cross-multiplication in bigint qty4, so the rule never touches floating point.
 */
export const MARKDOWN_WINDOW_DAYS = 28;
export const MARKDOWN_CAP_PERCENT = 50;
/** A write-off may take stock that expires within this many days (expired included). */
export const WRITEOFF_HORIZON_DAYS = 7;
/** Near-expiry list horizon: default and maximum (days). */
export const NEAR_EXPIRY_DEFAULT_DAYS = 30;
export const NEAR_EXPIRY_MAX_DAYS = 365;

const DAY_MS = 86_400_000;

/** Whole days from `from` to `to` (both `YYYY-MM-DD`, UTC). Positive when `to` is later. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The UTC calendar date of an instant, `YYYY-MM-DD`. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const BANDS: readonly (readonly [maxDaysLeft: number, percent: number])[] = [
  [3, 40],
  [7, 30],
  [14, 20],
  [30, 10],
];

export interface MarkdownInput {
  /** Whole UTC days from today to the batch's expiry date. Negative: already expired. */
  readonly daysLeft: number;
  /** qty4 available (qty - reserved) of the batch and of every same-variant batch at the location that expires no later. */
  readonly stockAhead4: bigint;
  /** qty4 sold of the variant at the location in the sales window. */
  readonly sold4: bigint;
  readonly windowDays?: number;
}

/** The suggested markdown percent for one batch (see the rule in the module header). */
export function suggestMarkdownPercent(i: MarkdownInput): number {
  if (!Number.isInteger(i.daysLeft) || i.daysLeft < 0) return 0;
  if (i.stockAhead4 <= 0n) return 0;
  const band = BANDS.find(([max]) => i.daysLeft <= max);
  if (band === undefined) return 0;
  // r = (stockAhead4 * W / sold4) / daysLeft. num/den = r, both non-negative; den = 0 means no cover limit.
  const num = i.stockAhead4 * BigInt(i.windowDays ?? MARKDOWN_WINDOW_DAYS);
  const den = i.sold4 * BigInt(i.daysLeft);
  // Factor in tenths: 0, 0.5, 1, 1.5.
  let factorTenths: bigint;
  if (num <= den) factorTenths = 0n;
  else if (num <= 2n * den) factorTenths = 5n;
  else if (num <= 4n * den) factorTenths = 10n;
  else factorTenths = 15n;
  // band% x factor / 10, rounded down to a multiple of 5: floor(band x factor / 50) x 5.
  const raw = (BigInt(band[1]) * factorTenths) / 50n;
  return Math.min(MARKDOWN_CAP_PERCENT, Number(raw) * 5);
}
