import { deepFreeze } from "../util.ts";

import type { ResolvedTheme } from "../resolve.ts";

export type Paper = 58 | 80;

export interface ReceiptSettings {
  readonly charsPerLine: 32 | 48;
  readonly headerSize: "double";
  readonly totalBold: true;
  readonly logo: { readonly maxWidthDots: 384 | 576; readonly dither: "floyd-steinberg" };
}

const RECEIPT: Readonly<Record<Paper, ReceiptSettings>> = deepFreeze({
  58: {
    charsPerLine: 32,
    headerSize: "double",
    totalBold: true,
    logo: { maxWidthDots: 384, dither: "floyd-steinberg" },
  },
  80: {
    charsPerLine: 48,
    headerSize: "double",
    totalBold: true,
    logo: { maxWidthDots: 576, dither: "floyd-steinberg" },
  },
});

/**
 * ESC/POS settings for a paper width. Monochrome and theme-independent by design, so the theme
 * argument only keeps the signature uniform with the other compilers.
 */
export function toReceiptSettings(_theme: ResolvedTheme, paper: Paper): ReceiptSettings {
  return RECEIPT[paper];
}
