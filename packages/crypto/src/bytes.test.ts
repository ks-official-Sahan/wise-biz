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

describe("hand-rolled utf8", () => {
  const valid: [string, number[]][] = [
    ["", []],
    ["A", [0x41]],
    ["\u007f", [0x7f]],
    ["\u0080", [0xc2, 0x80]],
    ["\u07ff", [0xdf, 0xbf]],
    ["\u0800", [0xe0, 0xa0, 0x80]],
    ["\ud7ff", [0xed, 0x9f, 0xbf]],
    ["\ue000", [0xee, 0x80, 0x80]],
    ["\uffff", [0xef, 0xbf, 0xbf]],
    ["\u{10000}", [0xf0, 0x90, 0x80, 0x80]],
    ["\u{1F600}", [0xf0, 0x9f, 0x98, 0x80]],
    ["\u{10FFFF}", [0xf4, 0x8f, 0xbf, 0xbf]],
  ];
  it.each(valid)("encodes/decodes %j", (s, bytes) => {
    expect(Array.from(utf8(s))).toEqual(bytes);
    expect(fromUtf8(new Uint8Array(bytes))).toBe(s);
  });
  it("utf8 throws TypeError on lone surrogates", () => {
    for (const s of ["\ud800", "\udc00", "a\ud800b", "\ude00\ud83d", "\ud83d"]) {
      expect(() => utf8(s)).toThrow(TypeError);
    }
  });
  const invalid: number[][] = [
    [0x80],
    [0xc0, 0x80],
    [0xc1, 0xbf],
    [0xe0, 0x80, 0x80],
    [0xe0, 0x9f, 0xbf],
    [0xed, 0xa0, 0x80],
    [0xed, 0xbf, 0xbf],
    [0xf0, 0x80, 0x80, 0x80],
    [0xf0, 0x8f, 0xbf, 0xbf],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80],
    [0xf8, 0x88, 0x80, 0x80, 0x80],
    [0xc2],
    [0xe2, 0x82],
    [0xf0, 0x9f, 0x98],
    [0xc2, 0x41],
    [0xe2, 0x41, 0xac],
    [0xff],
  ];
  it.each(invalid)("fromUtf8 rejects %j", (...bytes) => {
    expect(() => fromUtf8(new Uint8Array(bytes))).toThrow(TypeError);
  });
  it("matches TextEncoder/TextDecoder on 10k random strings", () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder("utf-8", { fatal: true });
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 10000; i++) {
      let s = "";
      const len = rnd(12);
      for (let j = 0; j < len; j++) {
        const r = rnd(4);
        const cp = [0x7f, 0x7ff, 0xffff, 0x10ffff][r] ?? 0;
        let c = rnd(cp + 1);
        if (c >= 0xd800 && c <= 0xdfff) c = 0x20ac;
        s += String.fromCodePoint(c);
      }
      const b = utf8(s);
      expect(b).toEqual(enc.encode(s));
      expect(fromUtf8(b)).toBe(dec.decode(b));
    }
    // random byte soup: agree on accept/reject and result
    for (let i = 0; i < 10000; i++) {
      const b = new Uint8Array(rnd(6));
      for (let j = 0; j < b.length; j++) b[j] = rnd(256);
      let want: string | null;
      try {
        want = dec.decode(b);
      } catch {
        want = null;
      }
      if (want === null) expect(() => fromUtf8(b)).toThrow(TypeError);
      else expect(fromUtf8(b)).toBe(want);
    }
  });
});
