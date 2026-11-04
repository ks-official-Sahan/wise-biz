import { decode } from "@wise-biz/barcode";

import { fromQty4 } from "./qty.ts";

import type { CustomRule } from "@wise-biz/barcode";

export type ScanResult =
  | {
      readonly type: "variant";
      readonly variantId: string;
      /** Quantity to add (a weight label carries it). */
      readonly qty: string;
      /** A price label fixes the line price. */
      readonly priceOverrideMinor?: number;
      /** A GS1 code can carry the batch; the cart keeps it for inventory (P1-10). */
      readonly batch?: string;
    }
  | { readonly type: "unknown"; readonly code: string };

export interface ScanDeps {
  /** In-memory barcode map from the sync client: one Map read, no database. */
  readonly variantForBarcode: (code: string) => string | undefined;
  readonly rules?: readonly CustomRule[];
}

/**
 * Turns the text of a scan into what to add to the cart. Pure and synchronous: it must stay inside the 50 ms scan
 * budget on a low-end phone, so it only reads the in-memory map.
 */
export function resolveScan(raw: string, deps: ScanDeps): ScanResult {
  const d = decode(raw, deps.rules);
  const unknown = { type: "unknown", code: raw.trim() } as const;
  if (d === undefined) return unknown;
  switch (d.type) {
    case "retail": {
      const id = deps.variantForBarcode(d.code.raw) ?? deps.variantForBarcode(d.code.canonical);
      return id === undefined ? unknown : { type: "variant", variantId: id, qty: "1" };
    }
    case "custom": {
      const { custom } = d;
      // A prefix 20-29 code can also be an ordinary registered product: that exact code wins, with no measure applied.
      const whole = deps.variantForBarcode(custom.code);
      if (whole !== undefined) return { type: "variant", variantId: whole, qty: "1" };
      const id = deps.variantForBarcode(`${custom.rule.prefix}${custom.item}`);
      if (id === undefined) return unknown;
      if (custom.kind === "weight_g") {
        // grams -> kilograms: 1250 g = 1.25 (value * 10 ten-thousandths).
        return custom.value === 0
          ? unknown
          : { type: "variant", variantId: id, qty: fromQty4(custom.value * 10) };
      }
      if (custom.kind === "price_minor") {
        return custom.value === 0
          ? unknown
          : { type: "variant", variantId: id, qty: "1", priceOverrideMinor: custom.value };
      }
      return custom.value === 0
        ? unknown
        : { type: "variant", variantId: id, qty: String(custom.value) };
    }
    case "gs1": {
      const { gtin, batch } = d.fields;
      if (gtin === undefined) return unknown;
      const id =
        deps.variantForBarcode(gtin) ??
        (gtin.startsWith("0") ? deps.variantForBarcode(gtin.slice(1)) : undefined);
      return id === undefined
        ? unknown
        : { type: "variant", variantId: id, qty: "1", ...(batch === undefined ? {} : { batch }) };
    }
    case "plain": {
      const id = deps.variantForBarcode(d.text);
      return id === undefined ? unknown : { type: "variant", variantId: id, qty: "1" };
    }
  }
}
