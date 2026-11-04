/** One receipt, as data. Renderers (ESC/POS, HTML) read this and nothing else, so a console preview shows the same thing. */
export interface ReceiptLine {
  readonly name: string;
  /** Decimal quantity text ("2", "1.25"). */
  readonly qty: string;
  readonly unitMinor: number;
  readonly totalMinor: number;
  /** Discount on this line, shown under it. */
  readonly discountMinor?: number | undefined;
  readonly note?: string | undefined;
}

export interface ReceiptDoc {
  readonly currency: string;
  readonly locale: string;
  /** "Receipt 000123". */
  readonly number: string;
  /** ISO instant. */
  readonly at: string;
  readonly operator?: string | undefined;
  readonly store: {
    readonly name: string;
    readonly address?: readonly string[] | undefined;
    readonly taxIds?: readonly string[] | undefined;
  };
  readonly header?: readonly string[] | undefined;
  readonly lines: readonly ReceiptLine[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxes: readonly { readonly name: string; readonly amountMinor: number }[];
  readonly feeMinor?: number | undefined;
  readonly roundingMinor?: number | undefined;
  readonly totalMinor: number;
  readonly tenders: readonly { readonly label: string; readonly amountMinor: number }[];
  readonly changeMinor: number;
  readonly loyalty?: { readonly balance: string } | undefined;
  /** Special note for this sale. */
  readonly note?: string | undefined;
  readonly footer?: readonly string[] | undefined;
  /** Digital receipt shortlink: printed as a QR and as text. */
  readonly qrUrl?: string | undefined;
  /** Opens the cash drawer after printing (a cash tender). */
  readonly openDrawer?: boolean | undefined;
}

/** "4.50" in USD, "450" in JPY: the currency decides the digits. Never a float on the wire; this is display only. */
export function formatMinor(minor: number, currency: string, locale: string): string {
  const digits =
    new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}

/** Timestamps print in the terminal's own zone and in a fixed order so a receipt is the same everywhere. */
export function formatDateTime(iso: string, locale: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(d);
}
