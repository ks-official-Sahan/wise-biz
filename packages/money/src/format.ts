import { exponentOf, toCurrency } from "./currency.ts";
import { MoneyArgumentError, MoneyParseError } from "./errors.ts";
import { fromBigint } from "./money.ts";

import type { Money } from "./money.ts";

export type FormatOptions = Readonly<{ display?: "symbol" | "code" | "name" }>;

function badLocale(locale: string, cause: unknown): MoneyArgumentError {
  const error = new MoneyArgumentError(`Invalid locale: ${locale}`);
  error.cause = cause;
  return error;
}

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
    try {
      formatter = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        currencyDisplay: display,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    } catch (cause) {
      throw badLocale(locale, cause);
    }
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
  let parts: Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(1234567.5);
  } catch (cause) {
    throw badLocale(locale, cause);
  }
  return {
    group: parts.find((p) => p.type === "group")?.value ?? "",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
}

const escapeRe = (c: string): string => c.replace(/[.*+?^${}()|[\]\\\-/]/g, "\\$&");

/** Integer part: plain digits (or empty) or properly 3-digit grouped. */
function groupedInteger(group: string): RegExp {
  if (group === "") return /^\d*$/;
  const spaceLike = /^[\s\u00a0\u202f]$/.test(group);
  const g = spaceLike ? "[ \\u00a0\\u202f]" : escapeRe(group);
  return new RegExp(`^(?:\\d*|\\d{1,3}(?:${g}\\d{3})+)$`);
}

/** Parse a plain localized number (optional leading minus) into Money. Rejects excess decimals. */
export function parse(input: string, currency: string, locale = "en-US"): Money {
  const exponent = exponentOf(currency);
  const { group, decimal } = separators(locale);
  let text = input.trim();
  const negative = text.startsWith("-") || text.startsWith("−");
  if (negative) text = text.slice(1);
  const pieces = text.split(decimal);
  let whole = pieces[0] ?? "";
  const fraction = pieces[1] ?? "";
  if (pieces.length <= 2 && groupedInteger(group).test(whole)) whole = whole.replace(/\D/g, "");
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
  return fromBigint(negative ? -minor : minor, toCurrency(currency));
}
