import { canonicalize, fromHex, sha256, toHex, utf8 } from "@wise-biz/crypto";

declare const chainHashBrand: unique symbol;
/** Lowercase 64-char hex SHA-256 digest. */
export type ChainHash = string & { readonly [chainHashBrand]: true };

const HASH_RE = /^[0-9a-f]{64}$/;

/** The `prevHash` of the first row of a new chain. */
export const GENESIS_HASH = "0".repeat(64) as ChainHash;

export function isChainHash(v: unknown): v is ChainHash {
  return typeof v === "string" && HASH_RE.test(v);
}

/**
 * hash = hex(sha256( utf8(canonicalize(payload)) || fromHex(prevHash) ))
 *
 * Byte layout (other implementations must match exactly):
 *   1. canonicalize(payload): RFC 8785 JSON Canonicalization Scheme string, UTF-8 encoded
 *   2. followed immediately by the 32 raw bytes of prevHash (hex-decoded, NOT the hex text)
 *   3. no separator, no length prefix, no domain tag
 * Output is lowercase hex.
 */
export function link(prevHash: string, payload: unknown): ChainHash {
  if (!isChainHash(prevHash)) throw new TypeError("prevHash must be 64 lowercase hex chars");
  const body = utf8(canonicalize(payload));
  const prev = fromHex(prevHash);
  const buf = new Uint8Array(body.length + prev.length);
  buf.set(body, 0);
  buf.set(prev, body.length);
  return toHex(sha256(buf)) as ChainHash;
}

export type ChainRow = Readonly<{ payload: unknown; prevHash: string; hash: string }>;

export type VerifyOptions = Readonly<{
  /** Hash the first row must link to. Default GENESIS_HASH. */
  startHash?: string;
  /** Anchored head (e.g. from a signed daily anchor). */
  expectedHead?: string;
  /** Anchored row count. */
  expectedLength?: number;
}>;

export type VerifyFailure =
  "prev_mismatch" | "hash_mismatch" | "malformed" | "head_mismatch" | "length_mismatch";

export type VerifyResult =
  | { ok: true; head: ChainHash; length: number }
  | { ok: false; index: number; reason: VerifyFailure };

/**
 * Walks rows in order and reports the FIRST broken index.
 * Row i must satisfy prevHash === hash of row i-1 (startHash for i=0) and
 * hash === link(prevHash, payload).
 *
 * Tail truncation (deleting the last rows) leaves a perfectly valid shorter chain, so it
 * is only detectable against an external anchor: pass `expectedHead` / `expectedLength`.
 * Those failures report index = rows.length (the position where rows are missing/extra).
 * An empty list is ok with head = startHash, length 0, subject to the anchors.
 */
export function verifyChain(rows: readonly ChainRow[], opts: VerifyOptions = {}): VerifyResult {
  const start = opts.startHash ?? GENESIS_HASH;
  if (!isChainHash(start)) throw new TypeError("startHash must be 64 lowercase hex chars");
  let prev: string = start;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as ChainRow | null | undefined;
    if (
      row == null ||
      typeof row !== "object" ||
      !isChainHash(row.prevHash) ||
      !isChainHash(row.hash)
    ) {
      return { ok: false, index: i, reason: "malformed" };
    }
    if (row.prevHash !== prev) return { ok: false, index: i, reason: "prev_mismatch" };
    let expected: ChainHash;
    try {
      expected = link(row.prevHash, row.payload);
    } catch {
      return { ok: false, index: i, reason: "malformed" };
    }
    if (row.hash !== expected) return { ok: false, index: i, reason: "hash_mismatch" };
    prev = row.hash;
  }
  if (opts.expectedHead !== undefined && opts.expectedHead !== prev) {
    return { ok: false, index: rows.length, reason: "head_mismatch" };
  }
  if (opts.expectedLength !== undefined && opts.expectedLength !== rows.length) {
    return { ok: false, index: rows.length, reason: "length_mismatch" };
  }
  return { ok: true, head: prev as ChainHash, length: rows.length };
}
