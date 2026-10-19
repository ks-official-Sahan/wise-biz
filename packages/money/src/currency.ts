import { UnknownCurrencyError } from "./errors.ts";

declare const currencyBrand: unique symbol;
/** An ISO 4217 code that passed {@link isCurrency}. */
export type Currency = string & { readonly [currencyBrand]: true };

const EXPONENT_0 = "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF";
const EXPONENT_3 = "BHD IQD JOD KWD LYD OMR TND";
const EXPONENT_4 = "CLF UYW";
const EXPONENT_2 =
  "AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB BOV BRL BSD BTN BWP BYN BZD " +
  "CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL " +
  "GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD " +
  "LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB " +
  "PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP " +
  "SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XCD XCG YER ZAR ZMW ZWG";

function build(): Readonly<Record<string, number>> {
  const table: Record<string, number> = {};
  const groups: readonly (readonly [string, number])[] = [
    [EXPONENT_0, 0],
    [EXPONENT_2, 2],
    [EXPONENT_3, 3],
    [EXPONENT_4, 4],
  ];
  for (const [list, exponent] of groups) {
    for (const code of list.split(" ")) table[code] = exponent;
  }
  return Object.freeze(table);
}

/** Active ISO 4217 currency codes mapped to their minor-unit exponent. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = build();

export function isCurrency(code: string): code is Currency {
  return Object.hasOwn(CURRENCY_EXPONENTS, code);
}

export function exponentOf(code: string): number {
  const exponent = Object.hasOwn(CURRENCY_EXPONENTS, code) ? CURRENCY_EXPONENTS[code] : undefined;
  if (exponent === undefined) throw new UnknownCurrencyError(code);
  return exponent;
}

export function toCurrency(code: string): Currency {
  if (!isCurrency(code)) throw new UnknownCurrencyError(code);
  return code;
}
