import { checkDigit } from "@wise-biz/barcode";

/** A label to print: one variant, how many copies. */
export interface LabelItem {
  readonly variantId: string;
  readonly name: string;
  readonly sku: string;
  /** The barcode to print, or null when the variant has none. */
  readonly code: string | null;
  /** Shelf price text shown on the label ("" = none). */
  readonly price: string;
  readonly copies: number;
}

const L = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
];
const R = L.map((c) =>
  c
    .split("")
    .map((b) => (b === "0" ? "1" : "0"))
    .join(""),
);
const G = R.map((c) => c.split("").reverse().join(""));
const PARITY = [
  "LLLLLL",
  "LLGLGG",
  "LLGGLG",
  "LLGGGL",
  "LGLLGG",
  "LGGLLG",
  "LGGGLL",
  "LGLGLG",
  "LGLGGL",
  "LGGLGL",
];

/** True for 13 digits whose last digit is the correct EAN-13 check digit. */
export function isEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return checkDigit(code.slice(0, 12)) === Number(code[12]);
}

/** UPC-A is an EAN-13 with a leading zero; anything else is not drawn here. */
export function toEan13(code: string): string | null {
  if (isEan13(code)) return code;
  if (/^\d{12}$/.test(code) && isEan13(`0${code}`)) return `0${code}`;
  return null;
}

/** The 95 modules of an EAN-13 symbol as "1" (bar) and "0" (space), or null when the code is not EAN-13 or UPC-A. */
export function ean13Modules(code: string): string | null {
  const c = toEan13(code);
  if (c === null) return null;
  const digits = c.split("").map(Number);
  const parity = PARITY[digits[0] ?? 0] ?? "";
  let out = "101";
  for (let i = 0; i < 6; i++) {
    const d = digits[i + 1] ?? 0;
    out += (parity[i] === "L" ? L[d] : G[d]) ?? "";
  }
  out += "01010";
  for (let i = 7; i < 13; i++) out += R[digits[i] ?? 0] ?? "";
  return `${out}101`;
}

/** Merges runs of bars so an SVG draws one rect per bar. */
export function barRuns(modules: string): { x: number; w: number }[] {
  const runs: { x: number; w: number }[] = [];
  let i = 0;
  while (i < modules.length) {
    if (modules[i] === "1") {
      let j = i;
      while (modules[j] === "1") j++;
      runs.push({ x: i, w: j - i });
      i = j;
    } else i++;
  }
  return runs;
}

/** Printer text must not carry ZPL control characters or anything outside printable ASCII. */
export function zplText(text: string): string {
  let out = "";
  for (const ch of text) out += ch >= " " && ch <= "~" && ch !== "^" && ch !== "~" ? ch : "?";
  return out;
}

export interface ZplOptions {
  /** Label width and height in dots (203 dpi: 50 x 30 mm is 400 x 240). */
  readonly widthDots?: number;
  readonly heightDots?: number;
}

/** One ZPL label per item with its copy count; one job for the whole batch. */
export function toZpl(items: readonly LabelItem[], o: ZplOptions = {}): string {
  const w = o.widthDots ?? 400;
  const h = o.heightDots ?? 240;
  return items
    .filter((i) => i.copies > 0)
    .map((i) => {
      const lines = [`^XA`, `^PW${String(w)}`, `^LL${String(h)}`];
      lines.push(`^FO20,16^A0N,28,28^FB${String(w - 40)},2,0,L^FD${zplText(i.name)}^FS`);
      lines.push(`^FO20,${String(h - 48)}^A0N,22,22^FD${zplText(i.sku)}^FS`);
      if (i.price !== "")
        lines.push(`^FO${String(w - 160)},${String(h - 56)}^A0N,36,36^FD${zplText(i.price)}^FS`);
      const ean = i.code === null ? null : toEan13(i.code);
      if (ean !== null) lines.push(`^FO40,80^BY2^BEN,70,Y,N^FD${ean.slice(0, 12)}^FS`);
      else if (i.code !== null) lines.push(`^FO40,80^BY2^BCN,70,Y,N,N^FD${zplText(i.code)}^FS`);
      lines.push(`^PQ${String(i.copies)},0,1,N`, `^XZ`);
      return lines.join("\n");
    })
    .join("\n");
}

/** Whole sheets of A4 labels: how many copies in total and how many sheets at `perSheet` labels each. */
export function sheetCount(
  items: readonly LabelItem[],
  perSheet: number,
): { labels: number; sheets: number } {
  const labels = items.reduce((n, i) => n + Math.max(0, i.copies), 0);
  return { labels, sheets: perSheet > 0 ? Math.ceil(labels / perSheet) : 0 };
}
