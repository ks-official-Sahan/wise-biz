/** Retail symbologies: check digits and normalisation to one canonical GTIN-13 so a scan and a stored code compare equal. */

const DIGITS = /^\d+$/;

/** GS1 mod-10 check digit for the digits before it (right to left weights 3, 1, 3, ...). */
export function checkDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

/** True for a digit string of length 8, 12, 13 or 14 whose last digit is the correct GS1 check digit. */
export function isValidGtin(code: string): boolean {
  if (!DIGITS.test(code)) return false;
  if (![8, 12, 13, 14].includes(code.length)) return false;
  return checkDigit(code.slice(0, -1)) === code.charCodeAt(code.length - 1) - 48;
}

/** Expands a 8-digit UPC-E (number system 0 or 1) to its 12-digit UPC-A, or undefined. */
export function upcEToUpcA(upcE: string): string | undefined {
  if (!/^[01]\d{7}$/.test(upcE)) return undefined;
  const ns = upcE.charAt(0);
  const d = upcE.slice(1, 7);
  const check = upcE.charAt(7);
  const last = d.charAt(5);
  let body: string;
  if (last === "0" || last === "1" || last === "2") {
    body = `${d.slice(0, 2)}${last}0000${d.slice(2, 5)}`;
  } else if (last === "3") {
    body = `${d.slice(0, 3)}00000${d.slice(3, 5)}`;
  } else if (last === "4") {
    body = `${d.slice(0, 4)}00000${d.charAt(4)}`;
  } else {
    body = `${d.slice(0, 5)}0000${last}`;
  }
  const upcA = `${ns}${body}${check}`;
  return isValidGtin(upcA) ? upcA : undefined;
}

export type RetailKind = "ean13" | "ean8" | "upca" | "upce" | "gtin14";

export interface RetailCode {
  readonly kind: RetailKind;
  /** The code as scanned. */
  readonly raw: string;
  /** GTIN-13 with leading zeros (EAN-8 stays 8 digits: it has no 13-digit form). The key for catalog lookup. */
  readonly canonical: string;
}

/** Recognises EAN-13, EAN-8, UPC-A, UPC-E and GTIN-14 with a valid check digit; anything else is undefined. */
export function parseRetail(code: string): RetailCode | undefined {
  if (!DIGITS.test(code)) return undefined;
  switch (code.length) {
    case 13:
      return isValidGtin(code) ? { kind: "ean13", raw: code, canonical: code } : undefined;
    case 12:
      return isValidGtin(code) ? { kind: "upca", raw: code, canonical: `0${code}` } : undefined;
    case 8: {
      const a = upcEToUpcA(code);
      if (a !== undefined) return { kind: "upce", raw: code, canonical: `0${a}` };
      return isValidGtin(code) ? { kind: "ean8", raw: code, canonical: code } : undefined;
    }
    case 14:
      return isValidGtin(code) ? { kind: "gtin14", raw: code, canonical: code } : undefined;
    default:
      return undefined;
  }
}
