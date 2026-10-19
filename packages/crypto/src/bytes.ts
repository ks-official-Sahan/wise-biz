/** Raw byte string. */
export type Bytes = Uint8Array;

/**
 * Hand-written UTF-8: no TextEncoder/TextDecoder (absent on Hermes), so this module imports
 * cleanly on any runtime.
 */
export function utf8(s: string): Bytes {
  const n = s.length;
  let size = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) size += 1;
    else if (c < 0x800) size += 2;
    else if (c >= 0xd800 && c <= 0xdfff) {
      const d = i + 1 < n ? s.charCodeAt(i + 1) : 0;
      if (c > 0xdbff || d < 0xdc00 || d > 0xdfff) throw new TypeError("lone surrogate");
      i++;
      size += 4;
    } else size += 3;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (let i = 0; i < n; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out[o++] = c;
    else if (c < 0x800) {
      out[o++] = 0xc0 | (c >> 6);
      out[o++] = 0x80 | (c & 63);
    } else if (c >= 0xd800 && c <= 0xdbff) {
      c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
      out[o++] = 0xf0 | (c >> 18);
      out[o++] = 0x80 | ((c >> 12) & 63);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    } else {
      out[o++] = 0xe0 | (c >> 12);
      out[o++] = 0x80 | ((c >> 6) & 63);
      out[o++] = 0x80 | (c & 63);
    }
  }
  return out;
}

const bad = (): never => {
  throw new TypeError("invalid UTF-8");
};

/** Strict decode: rejects overlong forms, surrogates, > U+10FFFF and truncated sequences. */
export function fromUtf8(b: Bytes): string {
  const n = b.length;
  let out = "";
  const units: number[] = [];
  const flush = (): void => {
    out += String.fromCharCode(...units);
    units.length = 0;
  };
  let i = 0;
  while (i < n) {
    const c = b[i++] ?? 0;
    let cp: number;
    if (c < 0x80) cp = c;
    else {
      let need: number;
      let min: number;
      if (c >= 0xc2 && c <= 0xdf) {
        need = 1;
        min = 0x80;
        cp = c & 0x1f;
      } else if (c >= 0xe0 && c <= 0xef) {
        need = 2;
        min = 0x800;
        cp = c & 0x0f;
      } else if (c >= 0xf0 && c <= 0xf4) {
        need = 3;
        min = 0x10000;
        cp = c & 0x07;
      } else return bad();
      if (i + need > n) return bad();
      for (let k = 0; k < need; k++) {
        const cc = b[i++] ?? 0;
        if ((cc & 0xc0) !== 0x80) return bad();
        cp = (cp << 6) | (cc & 63);
      }
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return bad();
    }
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else units.push(cp);
    if (units.length >= 4096) flush();
  }
  flush();
  return out;
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
