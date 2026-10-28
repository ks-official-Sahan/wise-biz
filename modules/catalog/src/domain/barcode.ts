import { DomainError } from "@wise-biz/errors";

export const BARCODE_FORMATS = [
  "ean13",
  "ean8",
  "upca",
  "upce",
  "code128",
  "code39",
  "qr",
  "datamatrix",
  "gs1_128",
  "other",
] as const;
export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];

const PRINTABLE = /^[\x21-\x7e]{1,64}$/;
const DIGITS = /^\d+$/;
const FIXED: Partial<Record<BarcodeFormat, number>> = { ean13: 13, ean8: 8, upca: 12, upce: 8 };

/** GS1 mod-10 check digit over every digit but the last (EAN-8/13, UPC-A). UPC-E: check upceToUpca(code). */
export function gs1CheckDigitOk(code: string): boolean {
  let sum = 0;
  for (let i = code.length - 2, w = 3; i >= 0; i--, w = 4 - w) sum += (code.charCodeAt(i) - 48) * w;
  return (10 - (sum % 10)) % 10 === code.charCodeAt(code.length - 1) - 48;
}

/** UPC-E (8 digits: number system 0/1, six digits, check) expanded to its UPC-A form; the check digit is shared. */
export function upceToUpca(code: string): string {
  const ns = code.slice(0, 1);
  const d = code.slice(1, 7);
  const check = code.slice(7);
  const last = d.charAt(5);
  const body =
    last <= "2"
      ? `${d.slice(0, 2)}${last}0000${d.slice(2, 5)}`
      : last === "3"
        ? `${d.slice(0, 3)}00000${d.slice(3, 5)}`
        : last === "4"
          ? `${d.slice(0, 4)}00000${d.charAt(4)}`
          : `${d.slice(0, 5)}0000${last}`;
  return `${ns}${body}${check}`;
}

const invalid = (index: number, message: string): never => {
  throw new DomainError("VALIDATION_FAILED", message, {
    fieldErrors: [{ path: `barcodes.${String(index)}.code`, message }],
  });
};

/** Validates one barcode and settles its format. Retail digit formats must carry a correct check digit. */
export function normaliseBarcode(
  input: { code: string; format?: BarcodeFormat | undefined },
  index: number,
): { code: string; format: BarcodeFormat } {
  const code = input.code.trim();
  if (!PRINTABLE.test(code)) invalid(index, "Use 1 to 64 printable characters without spaces.");
  const digits = DIGITS.test(code);
  const format: BarcodeFormat =
    input.format ??
    (digits && code.length === 13
      ? "ean13"
      : digits && code.length === 8
        ? "ean8"
        : digits && code.length === 12
          ? "upca"
          : "code128");
  const length = FIXED[format];
  if (length !== undefined) {
    if (!digits || code.length !== length)
      invalid(index, `${format} needs ${String(length)} digits.`);
    if (format === "upce" && !/^[01]/.test(code)) invalid(index, "upce starts with 0 or 1.");
    const checked = format === "upce" ? upceToUpca(code) : code;
    if (!gs1CheckDigitOk(checked)) invalid(index, "Check digit is wrong. Scan the code again.");
  }
  return { code, format };
}

/** Normalises a set and rejects duplicates inside the request (the database rejects them across variants). */
export function normaliseBarcodes(
  list: readonly { code: string; format?: BarcodeFormat | undefined }[],
): { code: string; format: BarcodeFormat }[] {
  const out = list.map((b, i) => normaliseBarcode(b, i));
  const seen = new Set<string>();
  out.forEach((b, i) => {
    if (seen.has(b.code)) invalid(i, "This barcode is listed twice.");
    seen.add(b.code);
  });
  return out;
}
