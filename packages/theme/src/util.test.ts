import { describe, expect, it } from "vitest";

import { canonicalJson, deepFreeze, fnv1a, kebab, remember } from "./util.ts";

describe("util", () => {
  it("sorts keys and drops undefined members in canonical JSON", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: undefined }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"z":1}]},"b":1}',
    );
  });

  it("handles null, booleans and strings", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson('a"b')).toBe('"a\\"b"');
  });

  it("hashes with 32-bit FNV-1a", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
  });

  it("deep freezes nested objects and arrays", () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBeNull();
  });

  it("evicts the oldest entry when the limit is reached", () => {
    const cache = new Map<string, number>();
    remember(cache, "a", 1, 2);
    remember(cache, "b", 2, 2);
    remember(cache, "c", 3, 2);
    expect([...cache.keys()]).toEqual(["b", "c"]);
  });

  it("converts camelCase to kebab-case", () => {
    expect(kebab("surfaceRaised")).toBe("surface-raised");
    expect(kebab("text")).toBe("text");
  });
});

describe("remember edge", () => {
  it("stores into an empty cache with a zero limit", () => {
    const cache = new Map<string, number>();
    remember(cache, "a", 1, 0);
    expect(cache.get("a")).toBe(1);
  });
});
