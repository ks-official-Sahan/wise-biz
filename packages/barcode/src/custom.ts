import { checkDigit } from "./retail.ts";

/**
 * In-store variable-measure EAN-13 (prefix 20 to 29): `PP IIIII VVVVV C` where the item code selects the product and
 * the value digits carry a weight or a price. Layouts differ per tenant, so the rule is data, not code.
 */
export interface CustomRule {
  /** Two-digit prefix, "20" to "29". */
  readonly prefix: string;
  /** Digits of the item code after the prefix. */
  readonly itemDigits: number;
  /** Digits of the value after the item code. */
  readonly valueDigits: number;
  /** What the value means. `weight_g` and `price_minor` are integers; `qty` is a count. */
  readonly kind: "weight_g" | "price_minor" | "qty";
  /** Some labels hold an extra price check digit inside the value (not supported): the EAN check digit is always last. */
}

export interface CustomCode {
  readonly rule: CustomRule;
  /** The full EAN-13 as scanned. */
  readonly code: string;
  readonly item: string;
  readonly kind: CustomRule["kind"];
  readonly value: number;
}

/** The default layout used when a tenant has not configured one: 2 + 5 item + 5 value (weight in grams) + check. */
export const DEFAULT_RULES: readonly CustomRule[] = [
  { prefix: "20", itemDigits: 5, valueDigits: 5, kind: "weight_g" },
  { prefix: "21", itemDigits: 5, valueDigits: 5, kind: "price_minor" },
];

export function validateRule(rule: CustomRule): string | undefined {
  if (!/^2\d$/.test(rule.prefix)) return "prefix must be 20 to 29";
  if (!Number.isInteger(rule.itemDigits) || rule.itemDigits < 1)
    return "itemDigits must be at least 1";
  if (!Number.isInteger(rule.valueDigits) || rule.valueDigits < 1)
    return "valueDigits must be at least 1";
  if (2 + rule.itemDigits + rule.valueDigits !== 12)
    return "prefix, item and value must be 12 digits";
  return undefined;
}

/** Splits an EAN-13 that starts with a configured prefix. The check digit must be valid; no rule means undefined. */
export function parseCustom(
  code: string,
  rules: readonly CustomRule[] = DEFAULT_RULES,
): CustomCode | undefined {
  if (!/^\d{13}$/.test(code)) return undefined;
  if (checkDigit(code.slice(0, 12)) !== Number(code[12])) return undefined;
  const rule = rules.find((r) => code.startsWith(r.prefix) && validateRule(r) === undefined);
  if (rule === undefined) return undefined;
  const itemStart = 2;
  const valueStart = itemStart + rule.itemDigits;
  return {
    rule,
    code,
    item: code.slice(itemStart, valueStart),
    kind: rule.kind,
    value: Number(code.slice(valueStart, valueStart + rule.valueDigits)),
  };
}
