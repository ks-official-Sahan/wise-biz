import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CanonicalizeError, canonicalize } from "./canonical.ts";

describe("canonicalize", () => {
  it("sorts keys and strips whitespace", () => {
    expect(canonicalize({ b: 1, a: [1, { d: 2, c: 3 }], "": null })).toBe(
      '{"":null,"a":[1,{"c":3,"d":2}],"b":1}',
    );
  });

  it("orders keys by UTF-16 code units, not code points", () => {
    // U+20AC (0x20AC) < U+1F600 (surrogates 0xD83D..) in UTF-16; reverse of nothing, but
    // U+FF5E (0xFF5E) > U+1F600 (0xD83D) in UTF-16 while < in code points.
    expect(canonicalize({ "\u{1F600}": 1, "€": 2 })).toBe('{"€":2,"😀":1}');
    expect(canonicalize({ "～": 1, "\u{1F600}": 2 })).toBe('{"😀":2,"～":1}');
  });

  it("serializes numbers per ECMAScript", () => {
    expect(canonicalize([-0, 0, 1e21, 1e-7, 1.5, -3, 123456789012345680000])).toBe(
      "[0,0,1e+21,1e-7,1.5,-3,123456789012345680000]",
    );
  });

  it("serializes primitives", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize([])).toBe("[]");
    expect(canonicalize({})).toBe("{}");
  });

  it("escapes strings like JSON.stringify", () => {
    expect(canonicalize('\u0000\u001f\n\t"\\')).toBe('"\\u0000\\u001f\\n\\t\\"\\\\"');
    expect(canonicalize("  ")).toBe('"  "');
  });

  it("accepts null-prototype objects", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.z = 1;
    o.a = 2;
    expect(canonicalize(o)).toBe('{"a":2,"z":1}');
  });

  it("allows shared (non-cyclic) references", () => {
    const shared = { x: 1 };
    expect(canonicalize([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });

  it.each([
    ["undefined", undefined],
    ["undefined in object", { a: undefined }],
    ["undefined in array", [undefined]],
    ["function", () => 1],
    ["symbol", Symbol("s")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["Date", new Date(0)],
    ["Map", new Map()],
    [
      "class instance",
      new (class Foo {
        x = 1;
      })(),
    ],
  ])("rejects %s", (_n, v) => {
    expect(() => canonicalize(v)).toThrow(CanonicalizeError);
  });

  it("rejects cycles", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalize(a)).toThrow(CanonicalizeError);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalize(arr)).toThrow(/cyclic/);
  });

  it("matches JSON.stringify output re-parsed (property)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const c = canonicalize(v);
        expect(canonicalize(JSON.parse(c))).toBe(c);
      }),
    );
  });
});

describe("canonicalize hardening", () => {
  it("deep nesting throws CanonicalizeError, not RangeError", () => {
    let v: unknown = 1;
    for (let i = 0; i < 5000; i++) v = [v];
    expect(() => canonicalize(v)).toThrow(CanonicalizeError);
    let o: unknown = 1;
    for (let i = 0; i < 5000; i++) o = { a: o };
    expect(() => canonicalize(o)).toThrow(CanonicalizeError);
  });
  it("error messages leak no keys or values", () => {
    for (const v of [{ secretKey: { ssn: undefined } }, { secretKey: [1n] }, { secretKey: NaN }]) {
      try {
        canonicalize(v);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CanonicalizeError);
        expect((e as Error).message).not.toMatch(/secretKey|ssn/);
      }
    }
  });
  it("rejects lone surrogates in strings and keys", () => {
    expect(() => canonicalize("\ud800")).toThrow(CanonicalizeError);
    expect(() => canonicalize({ "\udc00x": 1 })).toThrow(CanonicalizeError);
    expect(() => canonicalize(["a\ud83d"])).toThrow(CanonicalizeError);
    expect(canonicalize("\ud83d\ude00")).toBe('"\u{1F600}"');
  });
});
