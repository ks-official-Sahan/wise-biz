import { parseHex } from "./color.ts";

/** WCAG 2.2 minimum contrast ratios: text 4.5, large text 3, non-text UI 3. */
export const REQUIRED = { text: 4.5, large: 3, ui: 3 } as const;

export type ContrastLevel = keyof typeof REQUIRED;

const linearChannel = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of a `#rrggbb` color, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** WCAG contrast ratio, from 1 to 21. Symmetric in its arguments. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsContrast(fg: string, bg: string, level: ContrastLevel): boolean {
  return contrastRatio(fg, bg) >= REQUIRED[level];
}
