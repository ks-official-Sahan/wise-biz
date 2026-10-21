import { describe, expect, it } from "vitest";

import { toHex } from "./bytes.ts";
import { constantTimeEqual } from "./compare.ts";
import { hmacSha256, sha256 } from "./hash.ts";

describe("sha256", () => {
  it("hashes known inputs", () => {
    expect(toHex(sha256("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(toHex(sha256(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256(new Uint8Array([0x61, 0x62, 0x63]))).toEqual(sha256("abc"));
  });
});

describe("hmacSha256", () => {
  it("matches RFC 4231 case 2 and accepts bytes or strings", () => {
    const expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
    expect(toHex(hmacSha256("Jefe", "what do ya want for nothing?"))).toBe(expected);
    const enc = new TextEncoder();
    expect(toHex(hmacSha256(enc.encode("Jefe"), enc.encode("what do ya want for nothing?")))).toBe(
      expected,
    );
  });
});

describe("constantTimeEqual", () => {
  it("compares strings and bytes", () => {
    expect(constantTimeEqual("secret", "secret")).toBe(true);
    expect(constantTimeEqual("secret", "secreT")).toBe(false);
    expect(constantTimeEqual("secret", "secret!")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(constantTimeEqual("abc", new Uint8Array([0x61, 0x62, 0x63]))).toBe(true);
  });
});
