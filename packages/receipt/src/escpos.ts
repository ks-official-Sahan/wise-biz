import { formatDateTime, formatMinor } from "./model.ts";

import type { ReceiptDoc } from "./model.ts";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type PaperWidth = 58 | 80;

export interface EscPosOptions {
  /** Paper width in mm: 58 prints 32 columns, 80 prints 48 (font A). */
  readonly width?: PaperWidth;
  /** Printer code page number for ESC t (0 = CP437, 19 = CP858). Text outside it is transliterated to ASCII. */
  readonly codePage?: 0 | 19;
  readonly timeZone?: string;
  /** Raster logo (see `rasterLogo`), printed first. */
  readonly logo?: Uint8Array;
  /** Feed lines before the cut. */
  readonly feed?: number;
  readonly cut?: boolean;
}

const COLUMNS: Record<PaperWidth, number> = { 58: 32, 80: 48 };

/** Characters a code page can print directly, besides ASCII. Everything else is folded to ASCII. */
const CP858 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ";

function toBytes(text: string, codePage: 0 | 19): number[] {
  const out: number[] = [];
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0) ?? 63;
    if (code >= 0x20 && code < 0x7f) {
      out.push(code);
      continue;
    }
    if (codePage === 19) {
      const i = CP858.indexOf(ch);
      if (i >= 0) {
        out.push(0x80 + i);
        continue;
      }
    }
    // Fold accents (é -> e); anything left becomes "?" so a receipt never prints garbage control bytes.
    const folded = ch.normalize("NFD").replace(/\p{M}/gu, "");
    const c = folded.codePointAt(0) ?? 63;
    out.push(c >= 0x20 && c < 0x7f ? c : 0x3f);
  }
  return out;
}

/** Width of text in printer columns (one per character; the supported code pages are single-byte). */
const len = (s: string): number => [...s.normalize("NFC")].length;

function wrap(text: string, cols: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== "");
  const lines: string[] = [];
  let cur = "";
  for (let w of words) {
    while (len(w) > cols) {
      if (cur !== "") {
        lines.push(cur);
        cur = "";
      }
      lines.push([...w].slice(0, cols).join(""));
      w = [...w].slice(cols).join("");
    }
    if (cur === "") cur = w;
    else if (len(cur) + 1 + len(w) <= cols) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur !== "") lines.push(cur);
  return lines.length === 0 ? [""] : lines;
}

/** Left text and right text on one row, the left wrapped if it does not fit beside the right. */
export function row(left: string, right: string, cols: number): string[] {
  const room = cols - len(right) - 1;
  if (room < 4) return [...wrap(left, cols), right.padStart(cols)];
  const parts = wrap(left, room);
  const last = parts.pop() ?? "";
  const gap = cols - len(last) - len(right);
  return [...parts, `${last}${" ".repeat(Math.max(1, gap))}${right}`];
}

/** Dithers 8-bit grayscale (0 black .. 255 white) to 1-bit with Floyd-Steinberg, row-major, `true` = print a dot. */
export function ditherToMono(gray: Uint8Array, width: number, height: number): boolean[] {
  const err = Float32Array.from(gray);
  const out: boolean[] = new Array<boolean>(width * height).fill(false);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = err[i] ?? 255;
      const white = old >= 128;
      out[i] = !white;
      const e = old - (white ? 255 : 0);
      if (x + 1 < width) err[i + 1] = (err[i + 1] ?? 0) + (e * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) err[i + width - 1] = (err[i + width - 1] ?? 0) + (e * 3) / 16;
        err[i + width] = (err[i + width] ?? 0) + (e * 5) / 16;
        if (x + 1 < width) err[i + width + 1] = (err[i + width + 1] ?? 0) + e / 16;
      }
    }
  }
  return out;
}

/** GS v 0: a monochrome raster image, 8 dots per byte, most significant bit first. Width is padded to a byte. */
export function rasterLogo(dots: readonly boolean[], width: number, height: number): Uint8Array {
  const bytesPerRow = Math.ceil(width / 8);
  const data = new Uint8Array(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (dots[y * width + x] === true) {
        const at = y * bytesPerRow + (x >> 3);
        data[at] = (data[at] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return Uint8Array.from([
    GS,
    0x76,
    0x30,
    0x00,
    bytesPerRow & 0xff,
    bytesPerRow >> 8,
    height & 0xff,
    height >> 8,
    ...data,
  ]);
}

/** GS ( k: a QR code (model 2) with the data stored, then printed. Module size 4-6 reads well on thermal paper. */
export function qrCode(data: string, moduleSize = 5): number[] {
  const bytes = toBytes(data, 0);
  const n = bytes.length + 3;
  return [
    GS,
    0x28,
    0x6b,
    0x04,
    0x00,
    0x31,
    0x41,
    0x32,
    0x00, // model 2
    GS,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x43,
    moduleSize, // module size
    GS,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x45,
    0x31, // error correction M
    GS,
    0x28,
    0x6b,
    n & 0xff,
    n >> 8,
    0x31,
    0x50,
    0x30,
    ...bytes, // store
    GS,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x51,
    0x30, // print
  ];
}

/** ESC p: pulse pin 2 for the cash drawer (the same bytes the CashDrawer port sends through the printer). */
export const DRAWER_KICK: readonly number[] = [ESC, 0x70, 0x00, 0x19, 0xfa];

/**
 * ESC/POS bytes for a receipt: 58 or 80 mm, one code page, optional raster logo and QR, cut and drawer kick. Pure and
 * synchronous, so the sale screen can prebuild it while the cashier is on the tender sheet and send it the moment the
 * sale commits.
 */
export function encodeEscPos(doc: ReceiptDoc, options: EscPosOptions = {}): Uint8Array {
  const cols = COLUMNS[options.width ?? 80];
  const codePage = options.codePage ?? 0;
  const out: number[] = [ESC, 0x40, ESC, 0x74, codePage];
  const text = (s: string) => {
    out.push(...toBytes(s, codePage), LF);
  };
  const align = (a: 0 | 1 | 2) => out.push(ESC, 0x61, a);
  const bold = (on: boolean) => out.push(ESC, 0x45, on ? 1 : 0);
  const size = (big: boolean) => out.push(GS, 0x21, big ? 0x11 : 0x00);
  const rule = (ch = "-") => {
    text(ch.repeat(cols));
  };
  const money = (m: number) => formatMinor(m, doc.currency, doc.locale);

  if (options.logo !== undefined) {
    align(1);
    out.push(...options.logo, LF);
  }
  align(1);
  bold(true);
  for (const l of wrap(doc.store.name, cols)) text(l);
  bold(false);
  for (const l of doc.store.address ?? []) for (const w of wrap(l, cols)) text(w);
  for (const t of doc.store.taxIds ?? []) text(t);
  for (const h of doc.header ?? []) for (const w of wrap(h, cols)) text(w);
  align(0);
  rule();
  text(doc.number);
  text(formatDateTime(doc.at, doc.locale, options.timeZone));
  if (doc.operator !== undefined) text(`Served by ${doc.operator}`);
  rule();

  for (const line of doc.lines) {
    const detail = `${line.qty} x ${money(line.unitMinor)}`;
    for (const r of row(line.name, money(line.totalMinor), cols)) text(r);
    text(`  ${detail}`);
    if (line.discountMinor !== undefined && line.discountMinor > 0) {
      for (const r of row("  Discount", `-${money(line.discountMinor)}`, cols)) text(r);
    }
    if (line.note !== undefined) for (const w of wrap(line.note, cols - 2)) text(`  ${w}`);
  }
  rule();
  for (const r of row("Subtotal", money(doc.subtotalMinor), cols)) text(r);
  if (doc.discountMinor > 0)
    for (const r of row("Discounts", `-${money(doc.discountMinor)}`, cols)) text(r);
  if (doc.feeMinor !== undefined && doc.feeMinor > 0)
    for (const r of row("Fees", money(doc.feeMinor), cols)) text(r);
  for (const t of doc.taxes) for (const r of row(t.name, money(t.amountMinor), cols)) text(r);
  if (doc.roundingMinor !== undefined && doc.roundingMinor !== 0) {
    for (const r of row("Rounding", money(doc.roundingMinor), cols)) text(r);
  }
  bold(true);
  size(true);
  // Double width halves the columns.
  for (const r of row("TOTAL", money(doc.totalMinor), Math.floor(cols / 2))) text(r);
  size(false);
  bold(false);
  rule();
  for (const t of doc.tenders) for (const r of row(t.label, money(t.amountMinor), cols)) text(r);
  if (doc.changeMinor > 0) {
    bold(true);
    for (const r of row("Change", money(doc.changeMinor), cols)) text(r);
    bold(false);
  }
  if (doc.loyalty !== undefined) text(`Loyalty balance: ${doc.loyalty.balance}`);
  if (doc.note !== undefined) {
    rule();
    for (const w of wrap(doc.note, cols)) text(w);
  }
  align(1);
  for (const f of doc.footer ?? []) for (const w of wrap(f, cols)) text(w);
  if (doc.qrUrl !== undefined) {
    out.push(LF, ...qrCode(doc.qrUrl), LF);
    for (const w of wrap(doc.qrUrl, cols)) text(w);
  }
  out.push(...Array<number>(options.feed ?? 4).fill(LF));
  if (options.cut ?? true) out.push(GS, 0x56, 0x42, 0x00);
  if (doc.openDrawer === true) out.push(...DRAWER_KICK);
  return Uint8Array.from(out);
}
