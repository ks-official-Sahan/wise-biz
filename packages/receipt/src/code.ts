import { sha256, utf8 } from "@wise-biz/crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U

/**
 * The public code of a sale's digital receipt: 10 characters of Crockford base32 from sha256(saleId). The terminal
 * computes it offline when it prints the QR; the server computes the same code when the sale arrives, so the link
 * works as soon as the sale has synced and no upload is needed. 50 bits: guessing a valid code is not practical
 * and a receipt holds no card data.
 */
export function receiptCode(saleId: string): string {
  const h = sha256(utf8(saleId));
  let out = "";
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < h.length && out.length < 10; i++) {
    acc = (acc << 8) | (h[i] ?? 0);
    bits += 8;
    while (bits >= 5 && out.length < 10) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31] ?? "0";
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

/** Codes are upper-case Crockford; scanners and people may send lower case or O for 0. */
export function normalizeReceiptCode(input: string): string | undefined {
  const c = input.trim().toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(c) ? c : undefined;
}
