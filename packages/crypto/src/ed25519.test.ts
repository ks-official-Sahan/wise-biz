import { describe, expect, it } from "vitest";

import { toBase64url } from "./bytes.ts";
import { fingerprint, generateKeyPair, publicKeyFrom, sign, verify } from "./ed25519.ts";
import { sha256 } from "./hash.ts";

describe("ed25519", () => {
  const kp = generateKeyPair();

  it("generates 32-byte keys and derives the public key", () => {
    expect(kp.secretKey).toHaveLength(32);
    expect(kp.publicKey).toHaveLength(32);
    expect(publicKeyFrom(kp.secretKey)).toEqual(kp.publicKey);
    expect(generateKeyPair().secretKey).not.toEqual(kp.secretKey);
  });

  it("signs and verifies bytes and strings", () => {
    const sig = sign("hello", kp.secretKey);
    expect(sig).toHaveLength(64);
    expect(verify(sig, "hello", kp.publicKey)).toBe(true);
    expect(verify(sig, new TextEncoder().encode("hello"), kp.publicKey)).toBe(true);
    expect(sign(new Uint8Array([1, 2, 3]), kp.secretKey)).toHaveLength(64);
  });

  it("rejects tampering", () => {
    const sig = sign("hello", kp.secretKey);
    expect(verify(sig, "hellO", kp.publicKey)).toBe(false);
    const bad = sig.slice();
    bad[0] = (bad[0] ?? 0) ^ 1;
    expect(verify(bad, "hello", kp.publicKey)).toBe(false);
    expect(verify(sig, "hello", generateKeyPair().publicKey)).toBe(false);
  });

  it("returns false (never throws) on malformed input", () => {
    const sig = sign("hello", kp.secretKey);
    expect(verify(sig.slice(0, 63), "hello", kp.publicKey)).toBe(false);
    expect(verify(new Uint8Array(0), "hello", kp.publicKey)).toBe(false);
    expect(verify(sig, "hello", kp.publicKey.slice(0, 31))).toBe(false);
    expect(verify(sig, "hello", new Uint8Array(32).fill(0xff))).toBe(false);
  });

  it("fingerprints stably", () => {
    expect(fingerprint(kp.publicKey)).toBe(toBase64url(sha256(kp.publicKey)));
    expect(fingerprint(kp.publicKey)).toBe(fingerprint(kp.publicKey));
    expect(fingerprint(kp.publicKey)).toHaveLength(43);
  });
});
