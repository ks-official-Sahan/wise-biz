import { ed25519 } from "@noble/curves/ed25519.js";

import { toBase64url, utf8 } from "./bytes.ts";
import { sha256 } from "./hash.ts";

import type { Bytes } from "./bytes.ts";

export type KeyPair = Readonly<{ secretKey: Bytes; publicKey: Bytes }>;

function msgBytes(m: Bytes | string): Bytes {
  return typeof m === "string" ? utf8(m) : m;
}

export function generateKeyPair(): KeyPair {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function publicKeyFrom(secretKey: Bytes): Bytes {
  return ed25519.getPublicKey(secretKey);
}

export function sign(message: Bytes | string, secretKey: Bytes): Bytes {
  return ed25519.sign(msgBytes(message), secretKey);
}

/** Strict RFC 8032 verification. Never throws; malformed input returns false. */
export function verify(signature: Bytes, message: Bytes | string, publicKey: Bytes): boolean {
  try {
    return ed25519.verify(signature, msgBytes(message), publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export function fingerprint(publicKey: Bytes): string {
  return toBase64url(sha256(publicKey));
}
