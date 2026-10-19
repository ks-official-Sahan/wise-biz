// @vitest-environment edge-runtime
import { describe, expect, it } from "vitest";

import {
  canonicalize,
  constantTimeEqual,
  fingerprint,
  generateKeyPair,
  hmacSha256,
  sha256,
  sign,
  toBase64url,
  toHex,
  verify,
} from "../src/index.ts";

describe("edge runtime smoke", () => {
  it("hashes, signs and verifies without Node built-ins", () => {
    expect(toHex(sha256("abc")).startsWith("ba7816bf")).toBe(true);
    expect(hmacSha256("k", "m")).toHaveLength(32);
    expect(constantTimeEqual("a", "a")).toBe(true);
    const kp = generateKeyPair();
    const msg = canonicalize({ b: 1, a: 2 });
    expect(msg).toBe('{"a":2,"b":1}');
    expect(verify(sign(msg, kp.secretKey), msg, kp.publicKey)).toBe(true);
    expect(fingerprint(kp.publicKey)).toBe(toBase64url(sha256(kp.publicKey)));
  });
});
