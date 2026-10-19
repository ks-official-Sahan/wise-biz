import { hmac } from "@noble/hashes/hmac.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

import { utf8 } from "./bytes.ts";

import type { Bytes } from "./bytes.ts";

function toBytes(v: Bytes | string): Bytes {
  return typeof v === "string" ? utf8(v) : v;
}

export function sha256(data: Bytes | string): Bytes {
  return nobleSha256(toBytes(data));
}

export function hmacSha256(key: Bytes | string, data: Bytes | string): Bytes {
  return hmac(nobleSha256, toBytes(key), toBytes(data));
}
