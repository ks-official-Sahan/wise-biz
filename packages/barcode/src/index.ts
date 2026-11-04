import { DEFAULT_RULES, parseCustom } from "./custom.ts";
import { parseGs1 } from "./gs1.ts";
import { parseRetail } from "./retail.ts";

import type { CustomCode, CustomRule } from "./custom.ts";
import type { Gs1Fields } from "./gs1.ts";
import type { RetailCode } from "./retail.ts";

export { DEFAULT_RULES, parseCustom, validateRule } from "./custom.ts";
export type { CustomCode, CustomRule } from "./custom.ts";
export { parseGs1 } from "./gs1.ts";
export type { Gs1Fields, Gs1Result } from "./gs1.ts";
export { checkDigit, isValidGtin, parseRetail, upcEToUpcA } from "./retail.ts";
export type { RetailCode, RetailKind } from "./retail.ts";
export { createWedgeDetector } from "./wedge.ts";
export type { WedgeDetector, WedgeOptions, WedgeResult } from "./wedge.ts";

export type Decoded =
  | { readonly type: "retail"; readonly code: RetailCode }
  /** In-store label: look the product up by `custom.item`, then apply the measure. */
  | { readonly type: "custom"; readonly custom: CustomCode }
  | { readonly type: "gs1"; readonly fields: Gs1Fields }
  /** Anything else (Code 128, Code 39, a vendor SKU): look it up as typed. */
  | { readonly type: "plain"; readonly text: string };

/**
 * One entry point for a scan. Order matters: a prefix 20-29 EAN-13 is an in-store label before it is a retail code,
 * and a GS1 string is recognised by its application identifiers.
 */
export function decode(
  raw: string,
  rules: readonly CustomRule[] = DEFAULT_RULES,
): Decoded | undefined {
  const text = raw.trim();
  if (text === "") return undefined;
  const custom = parseCustom(text, rules);
  if (custom !== undefined) return { type: "custom", custom };
  const retail = parseRetail(text);
  if (retail !== undefined) return { type: "retail", code: retail };
  if (text.startsWith("(") || text.includes("\u001d") || /^(01)\d{14}/.test(text)) {
    const g = parseGs1(text);
    if (g.ok) return { type: "gs1", fields: g.fields };
  }
  return { type: "plain", text };
}
