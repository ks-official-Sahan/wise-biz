import { exponentOf } from "./currency.ts";
import { MoneyParseError } from "./errors.ts";
import { fromBigint } from "./money.ts";

import type { Money } from "./money.ts";

export type FormatOptions = Readonly<{ display?: "symbol" | "code" | "name" }>;

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(
  locale: string,
  currency: string,
  display: "symbol" | "code" | "name",
): Intl.NumberFormat {
  const key = `${locale}|${currency}|${display}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    const digits = exponentOf(currency);
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: display,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/** Exact decimal string from integer minor units, no float division. */
function decimalString(minor: number, exponent: number): string {
  const digits = Math.abs(minor)
    .toString()
    .padStart(exponent + 1, "0");
  const cut = digits.length - exponent;
  const body = exponent === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return minor < 0 ? `-${body}` : body;
}

export function format(m: Money, locale: string, opts: FormatOptions = {}): string {
  const text = decimalString(m.minor, exponentOf(m.currency));
  return formatterFor(locale, m.currency, opts.display ?? "symbol").format(text as `${number}`);
}

function separators(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(1234567.5);
  return {
    group: parts.find((p) => p.type === "group")?.value ?? "",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
}

/** Parse a plain localized number (optional leading minus) into Money. Rejects excess decimals. */
export function parse(input: string, currency: string, locale = "en-US"): Money {
  const exponent = exponentOf(currency);
  const { group, decimal } = separators(locale);
  let text = input.trim();
  const negative = text.startsWith("-") || text.startsWith("−");
  if (negative) text = text.slice(1);
  text = group === "" ? text : text.split(group).join("");
  if (/^\s*$/.test(group)) text = text.replace(/\s/g, "");
  const pieces = text.split(decimal);
  const whole = pieces[0] ?? "";
  const fraction = pieces[1] ?? "";
  if (
    pieces.length > 2 ||
    !/^\d*$/.test(whole) ||
    !/^\d*$/.test(fraction) ||
    whole + fraction === ""
  ) {
    throw new MoneyParseError(`Cannot parse money amount: ${input}`);
  }
  if (fraction.length > exponent) {
    throw new MoneyParseError(
      `Too many decimals for ${currency} (max ${String(exponent)}): ${input}`,
    );
  }
  const minor = BigInt(`${whole === "" ? "0" : whole}${fraction.padEnd(exponent, "0")}`);
  return fromBigint(negative ? -minor : minor, currency);
}
