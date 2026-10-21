import { fromHex, sha256, toHex } from "@wise-biz/crypto";

import { isChainHash } from "./chain.ts";

import type { ChainHash } from "./chain.ts";

function hashWithPrefix(prefix: number, ...parts: Uint8Array[]): Uint8Array {
  let size = 1;
  for (const p of parts) size += p.length;
  const buf = new Uint8Array(size);
  buf[0] = prefix;
  let off = 1;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return sha256(buf);
}

/** Largest power of two strictly less than n (n >= 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function mth(leaves: readonly Uint8Array[], lo: number, hi: number): Uint8Array {
  const n = hi - lo;
  if (n === 0) return sha256(new Uint8Array(0));
  if (n === 1) return hashWithPrefix(0x00, leaves[lo] ?? new Uint8Array(0));
  const mid = lo + split(n);
  return hashWithPrefix(0x01, mth(leaves, lo, mid), mth(leaves, mid, hi));
}

/**
 * Merkle Tree Hash per RFC 6962 section 2.1 (SHA-256).
 * leaf = sha256(0x00 || bytes), node = sha256(0x01 || left || right), split at the largest
 * power of two < n (the last leaf is never duplicated). Empty list = sha256("").
 * Each input is a 64-char lowercase hex hash, decoded to its 32 bytes as the leaf data.
 */
export function merkleRoot(hashes: readonly string[]): ChainHash {
  const leaves = hashes.map((h) => {
    if (!isChainHash(h)) throw new TypeError("leaf must be 64 lowercase hex chars");
    return fromHex(h);
  });
  return toHex(mth(leaves, 0, leaves.length)) as ChainHash;
}
