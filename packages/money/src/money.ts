import { exponentOf } from "./currency.ts";
import { CurrencyMismatchError, MoneyOverflowError } from "./errors.ts";

export type Money = Readonly<{ minor: number; currency: string }>;

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MIN = -MAX;

function make(minor: number, currency: string): Money {
  if (!Number.isSafeInteger(minor)) throw new MoneyOverflowError();
  return Object.freeze({ minor: minor === 0 ? 0 : minor, currency });
}

/** Build Money from a bigint intermediate, enforcing the safe-integer guard. */
export function fromBigint(minor: bigint, currency: string): Money {
  if (minor > MAX || minor < MIN) throw new MoneyOverflowError();
  return make(Number(minor), currency);
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function money(minor: number, currency: string): Money {
  exponentOf(currency);
  return make(minor, currency);
}

export function zero(currency: string): Money {
  return money(0, currency);
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return make(a.minor + b.minor, a.currency);
}

export function sub(a: Money, b: Money): Money {
  same(a, b);
  return make(a.minor - b.minor, a.currency);
}

export function neg(a: Money): Money {
  return make(-a.minor, a.currency);
}

export function abs(a: Money): Money {
  return make(Math.abs(a.minor), a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return compare(a, b) === 0;
}

export function isZero(a: Money): boolean {
  return a.minor === 0;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0;
}

export function sum(list: readonly Money[], currency: string): Money {
  let total = zero(currency);
  for (const item of list) total = add(total, item);
  return total;
}
