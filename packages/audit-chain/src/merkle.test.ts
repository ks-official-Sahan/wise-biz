import { sha256, toHex, fromHex } from "@wise-biz/crypto";
import { describe, expect, it } from "vitest";

import { link, merkleRoot } from "./index.ts";

const leaves = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => link("0".repeat(64), { i }));

const cat = (...p: Uint8Array[]): Uint8Array => Uint8Array.from(p.flatMap((x) => [...x]));
const leafHash = (h: string): Uint8Array => sha256(cat(Uint8Array.of(0), fromHex(h)));

/** Independent reference: RFC 6962 MTH, straightforward recursion on slices. */
function ref(hs: string[]): Uint8Array {
  if (hs.length === 0) return sha256(new Uint8Array(0));
  if (hs.length === 1) return leafHash(at(hs, 0));
  let k = 1;
  while (k < hs.length / 2 || k * 2 < hs.length) k *= 2;
  if (k >= hs.length) k /= 2;
  return sha256(cat(Uint8Array.of(1), ref(hs.slice(0, k)), ref(hs.slice(k))));
}

describe("merkleRoot", () => {
  it.each([0, 1, 2, 3, 4, 5, 7, 8])("matches reference for n=%i", (n) => {
    expect(merkleRoot(leaves(n))).toBe(toHex(ref(leaves(n))));
  });
  it("empty is sha256 of empty string", () => {
    expect(merkleRoot([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("does not duplicate the last leaf", () => {
    const l = leaves(3);
    expect(merkleRoot(l)).not.toBe(merkleRoot([...l, at(l, 2)]));
  });
  it("changes if any leaf changes", () => {
    const l = leaves(7);
    const base = merkleRoot(l);
    for (let i = 0; i < l.length; i++) {
      const t = [...l];
      t[i] = link("0".repeat(64), { other: i });
      expect(merkleRoot(t)).not.toBe(base);
    }
  });
  it("rejects non-hash leaves", () => {
    expect(() => merkleRoot(["abc"])).toThrow(TypeError);
  });
});

function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error("index out of range");
  return v;
}
