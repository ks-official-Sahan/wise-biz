import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fromBase64url, fromHex, fromUtf8, toBase64url, toHex, utf8 } from "./bytes.ts";

describe("utf8", () => {
  it("round-trips", () => {
    expect(fromUtf8(utf8("héllo 😀"))).toBe("héllo 😀");
    expect(Array.from(utf8("a€"))).toEqual([0x61, 0xe2, 0x82, 0xac]);
  });
  it("rejects invalid utf8", () => {
    expect(() => fromUtf8(new Uint8Array([0xff]))).toThrow();
  });
});

describe("hex", () => {
  it("encodes lowercase and round-trips", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
    expect(fromHex("000FfF")).toEqual(new Uint8Array([0, 15, 255]));
    fc.assert(
      fc.property(fc.uint8Array(), (b) => {
        expect(fromHex(toHex(b))).toEqual(b);
      }),
    );
  });
  it("rejects bad input", () => {
    expect(() => fromHex("abc")).toThrow(RangeError);
    expect(() => fromHex("zz")).toThrow(RangeError);
    expect(() => fromHex("0g")).toThrow(RangeError);
  });
});

describe("base64url", () => {
  it("matches RFC 4648 vectors without padding", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["f", "Zg"],
      ["fo", "Zm8"],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg"],
      ["fooba", "Zm9vYmE"],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [plain, enc] of cases) {
      expect(toBase64url(utf8(plain))).toBe(enc);
      expect(fromBase64url(enc)).toEqual(utf8(plain));
    }
    expect(toBase64url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("-__-");
  });
  it("round-trips", () => {
    fc.assert(
      fc.property(fc.uint8Array(), (b) => {
        expect(fromBase64url(toBase64url(b))).toEqual(b);
      }),
    );
  });
  it("rejects invalid input", () => {
    expect(() => fromBase64url("Zg==")).toThrow(RangeError);
    expect(() => fromBase64url("Zm9v+")).toThrow(RangeError);
    expect(() => fromBase64url("a+b/")).toThrow(RangeError);
    expect(() => fromBase64url("Z")).toThrow(RangeError);
    expect(() => fromBase64url("é!!!")).toThrow(RangeError);
    expect(() => fromBase64url("Zh")).toThrow(RangeError); // non-zero trailing bits
  });
});
