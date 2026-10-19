/** Base class for every error thrown by @wise-biz/money. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** A minor-unit value is not a safe integer (overflow, NaN, fraction). */
export class MoneyOverflowError extends MoneyError {
  constructor(message = "Money amount is not a safe integer") {
    super(message);
    this.name = "MoneyOverflowError";
  }
}

export class UnknownCurrencyError extends MoneyError {
  readonly code: string;

  constructor(code: string) {
    super(`Unknown ISO 4217 currency: ${code}`);
    this.name = "UnknownCurrencyError";
    this.code = code;
  }
}

export class CurrencyMismatchError extends MoneyError {
  readonly expected: string;
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
    this.name = "CurrencyMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** A non-money argument (weights, ratio, increment, count) is invalid. */
export class MoneyArgumentError extends MoneyError {
  constructor(message: string) {
    super(message);
    this.name = "MoneyArgumentError";
  }
}

export class MoneyParseError extends MoneyError {
  constructor(message: string) {
    super(message);
    this.name = "MoneyParseError";
  }
}
