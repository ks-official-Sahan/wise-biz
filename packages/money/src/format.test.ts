import { describe, expect, it } from "vitest";

import { MoneyParseError, UnknownCurrencyError } from "./errors.ts";
import { format, parse } from "./format.ts";
import { money } from "./money.ts";

const nbsp = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

describe("format", () => {
  it.each([
    [123456, "USD", "en-US", "$1,234.56"],
    [-5, "USD", "en-US", "-$0.05"],
    [1234, "JPY", "en-US", "¥1,234"],
    [1234567, "BHD", "en-US", "BHD 1,234.567"],
    [123456, "LKR", "en-US", "LKR 1,234.56"],
    [0, "USD", "en-US", "$0.00"],
  ])("%i %s %s", (minor, currency, locale, expected) => {
    expect(nbsp(format(money(minor, currency), locale))).toBe(expected);
  });

  it("display options and de-DE", () => {
    expect(nbsp(format(money(123456, "USD"), "en-US", { display: "code" }))).toBe("USD 1,234.56");
    expect(format(money(100, "USD"), "en-US", { display: "name" })).toBe("1.00 US dollars");
    expect(nbsp(format(money(123456, "EUR"), "de-DE"))).toBe("1.234,56 €");
  });

  it("exact for values beyond float precision", () => {
    const text = format(money(Number.MAX_SAFE_INTEGER, "USD"), "en-US");
    expect(text).toBe("$90,071,992,547,409.91");
  });

  it("unknown currency throws", () => {
    expect(() => format({ minor: 1, currency: "XXX" }, "en-US")).toThrow(UnknownCurrencyError);
  });
});

describe("parse", () => {
  it("round-trips format output", () => {
    for (const [minor, currency, locale] of [
      [123456, "USD", "en-US"],
      [99, "USD", "en-US"],
      [1234, "JPY", "en-US"],
      [1234567, "BHD", "en-US"],
      [123456, "EUR", "de-DE"],
      [-123456, "EUR", "de-DE"],
      [123456789, "EUR", "fr-FR"],
    ] as const) {
      const m = money(minor, currency);
      const plain = format(m, locale, { display: "code" })
        .replace(currency, "")
        .replace(/[\u00a0\u202f]$|^[\u00a0\u202f]/g, "")
        .trim();
      expect(parse(plain, currency, locale)).toEqual(m);
    }
  });

  it("parses de-DE and en-US inputs", () => {
    expect(parse("1.234,56", "EUR", "de-DE")).toEqual(money(123456, "EUR"));
    expect(parse("1,234.56", "USD")).toEqual(money(123456, "USD"));
    expect(parse("-0.5", "USD")).toEqual(money(-50, "USD"));
    expect(parse("−5", "USD")).toEqual(money(-500, "USD"));
    expect(parse(" 12 ", "JPY")).toEqual(money(12, "JPY"));
    expect(parse(".5", "USD")).toEqual(money(50, "USD"));
    expect(parse("5.", "USD")).toEqual(money(500, "USD"));
    expect(parse("1 234,5", "EUR", "fr-FR")).toEqual(money(123450, "EUR"));
  });

  it("rejects bad input", () => {
    expect(() => parse("1.234", "USD")).toThrow(MoneyParseError);
    expect(() => parse("1.5", "JPY")).toThrow(MoneyParseError);
    expect(() => parse("", "USD")).toThrow(MoneyParseError);
    expect(() => parse("abc", "USD")).toThrow(MoneyParseError);
    expect(() => parse("1.2.3", "USD")).toThrow(MoneyParseError);
    expect(() => parse("1", "XXX")).toThrow(UnknownCurrencyError);
  });
});
