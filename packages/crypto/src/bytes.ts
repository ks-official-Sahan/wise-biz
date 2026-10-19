/** Raw byte string. */
export type Bytes = Uint8Array;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Bytes {
  return encoder.encode(s);
}

export function fromUtf8(b: Bytes): string {
  return decoder.decode(b);
}

const HEX = "0123456789abcdef";

export function toHex(b: Bytes): string {
  let out = "";
  for (const byte of b) out += HEX.charAt(byte >> 4) + HEX.charAt(byte & 15);
  return out;
}

function hexVal(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

export function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0) throw new RangeError("hex string has odd length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = hexVal(s.charCodeAt(2 * i));
    const lo = hexVal(s.charCodeAt(2 * i + 1));
    if (hi < 0 || lo < 0) throw new RangeError("invalid hex character");
    out[i] = (hi << 4) | lo;
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_REV = new Int8Array(128).fill(-1);
const at = (b: Bytes, i: number): number => b[i] ?? 0;
for (let i = 0; i < 64; i++) B64_REV[B64.charCodeAt(i)] = i;

export function toBase64url(b: Bytes): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (at(b, i) << 16) | (at(b, i + 1) << 8) | at(b, i + 2);
    out +=
      B64.charAt(n >> 18) +
      B64.charAt((n >> 12) & 63) +
      B64.charAt((n >> 6) & 63) +
      B64.charAt(n & 63);
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = at(b, i) << 16;
    out += B64.charAt(n >> 18) + B64.charAt((n >> 12) & 63);
  } else if (rest === 2) {
    const n = (at(b, i) << 16) | (at(b, i + 1) << 8);
    out += B64.charAt(n >> 18) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63);
  }
  return out;
}

export function fromBase64url(s: string): Bytes {
  const len = s.length;
  if (len % 4 === 1) throw new RangeError("invalid base64url length");
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? (B64_REV[c] ?? -1) : -1;
    if (v < 0) throw new RangeError("invalid base64url character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new RangeError("non-canonical base64url trailing bits");
  return out;
}
