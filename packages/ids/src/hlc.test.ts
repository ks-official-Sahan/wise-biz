import { describe, expect, it } from "vitest";

import {
  compareHlc,
  createHlc,
  HlcCounterOverflowError,
  HlcDriftError,
  parseHlc,
  serializeHlc,
} from "./hlc.ts";

import type { HlcTimestamp } from "./hlc.ts";

function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error("index out of range");
  return v;
}

describe("createHlc", () => {
  it("now() is strictly monotonic with a frozen clock", () => {
    const hlc = createHlc({ node: "a", now: () => 1000 });
    const a = hlc.now();
    const b = hlc.now();
    expect(a).toEqual({ wallMs: 1000, counter: 0, node: "a" });
    expect(b).toEqual({ wallMs: 1000, counter: 1, node: "a" });
    expect(compareHlc(a, b)).toBe(-1);
  });

  it("resets the counter when physical time advances and ignores backwards time", () => {
    let t = 1000;
    const hlc = createHlc({ node: "a", now: () => t });
    hlc.now();
    hlc.now();
    t = 2000;
    expect(hlc.now()).toMatchObject({ wallMs: 2000, counter: 0 });
    t = 1500;
    expect(hlc.now()).toMatchObject({ wallMs: 2000, counter: 1 });
  });

  it("defaults to Date.now", () => {
    const before = Date.now();
    const ts = createHlc({ node: "a" }).now();
    expect(ts.wallMs).toBeGreaterThanOrEqual(before);
  });

  it("throws on counter overflow", () => {
    const hlc = createHlc({ node: "a", now: () => 1 });
    for (let i = 0; i <= 0xffff; i++) hlc.now();
    expect(() => hlc.now()).toThrow(HlcCounterOverflowError);
  });

  it("receive merges remote ahead of local", () => {
    const hlc = createHlc({ node: "a", now: () => 1000 });
    const r = hlc.receive({ wallMs: 1100, counter: 5, node: "b" });
    expect(r).toEqual({ wallMs: 1100, counter: 6, node: "a" });
    expect(hlc.now()).toMatchObject({ wallMs: 1100, counter: 7 });
  });

  it("receive merges when local logical wall is ahead", () => {
    const hlc = createHlc({ node: "a", now: () => 1000 });
    hlc.now();
    const r = hlc.receive({ wallMs: 900, counter: 9, node: "b" });
    expect(r).toEqual({ wallMs: 1000, counter: 1, node: "a" });
  });

  it("receive takes the max counter when walls are equal", () => {
    const hlc = createHlc({ node: "a", now: () => 1000 });
    hlc.now();
    expect(hlc.receive({ wallMs: 1000, counter: 4, node: "b" }).counter).toBe(5);
    expect(hlc.receive({ wallMs: 1000, counter: 2, node: "b" }).counter).toBe(6);
  });

  it("receive resets counter when physical time dominates", () => {
    const hlc = createHlc({ node: "a", now: () => 2000 });
    expect(hlc.receive({ wallMs: 1000, counter: 9, node: "b" })).toEqual({
      wallMs: 2000,
      counter: 0,
      node: "a",
    });
  });

  it("receive overflow throws", () => {
    const hlc = createHlc({ node: "a", now: () => 1000 });
    expect(() => hlc.receive({ wallMs: 1000, counter: 0xffff, node: "b" })).toThrow(
      HlcCounterOverflowError,
    );
  });

  it("guards against drift", () => {
    const hlc = createHlc({ node: "a", now: () => 1000, maxDriftMs: 100 });
    expect(() => hlc.receive({ wallMs: 1100, counter: 0, node: "b" })).not.toThrow();
    try {
      hlc.receive({ wallMs: 1101, counter: 0, node: "b" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HlcDriftError);
      expect((e as HlcDriftError).driftMs).toBe(101);
    }
  });

  it("defaults maxDriftMs to 5 minutes", () => {
    const hlc = createHlc({ node: "a", now: () => 0 });
    expect(() => hlc.receive({ wallMs: 300_000, counter: 0, node: "b" })).not.toThrow();
    expect(() => hlc.receive({ wallMs: 300_001, counter: 0, node: "b" })).toThrow(HlcDriftError);
  });
});

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function sample(r: () => number): HlcTimestamp {
  return {
    wallMs: Math.floor(r() * 4) * 1000 + Math.floor(r() * 3),
    counter: Math.floor(r() * 3) * 0x7fff,
    node: at(["a", "b", "node-1", "Z"], Math.floor(r() * 4)),
  };
}

describe("compare / serialize / parse", () => {
  it("compares by wall, counter, node", () => {
    const base = { wallMs: 5, counter: 5, node: "m" };
    expect(compareHlc(base, { ...base })).toBe(0);
    expect(compareHlc(base, { ...base, wallMs: 6 })).toBe(-1);
    expect(compareHlc({ ...base, wallMs: 6 }, base)).toBe(1);
    expect(compareHlc(base, { ...base, counter: 4 })).toBe(1);
    expect(compareHlc(base, { ...base, counter: 6 })).toBe(-1);
    expect(compareHlc(base, { ...base, node: "n" })).toBe(-1);
    expect(compareHlc(base, { ...base, node: "l" })).toBe(1);
  });

  it("round-trips and lexical order equals compare order", () => {
    const r = rng(42);
    const xs = Array.from({ length: 300 }, () => sample(r));
    for (const x of xs) expect(parseHlc(serializeHlc(x))).toEqual(x);
    for (let i = 1; i < xs.length; i++) {
      const a = at(xs, i - 1);
      const b = at(xs, i);
      const sa = serializeHlc(a);
      const sb = serializeHlc(b);
      const lex = sa < sb ? -1 : sa > sb ? 1 : 0;
      expect(lex).toBe(compareHlc(a, b));
    }
  });

  it("serializes fixed-width", () => {
    expect(serializeHlc({ wallMs: 1, counter: 255, node: "n" })).toBe("0000000000001-00ff-n");
  });

  it("serialize rejects out-of-range fields", () => {
    expect(() => serializeHlc({ wallMs: -1, counter: 0, node: "n" })).toThrow(RangeError);
    expect(() => serializeHlc({ wallMs: 1e13, counter: 0, node: "n" })).toThrow(RangeError);
    expect(() => serializeHlc({ wallMs: 1, counter: 0x10000, node: "n" })).toThrow(RangeError);
    expect(() => serializeHlc({ wallMs: 1, counter: 0, node: "" })).toThrow(RangeError);
  });

  it("parse throws on bad input", () => {
    for (const bad of [
      "",
      "x",
      "1-0000-n",
      "0000000000001-00ff",
      "0000000000001-00ff-",
      "0000000000001-00fg-n",
      "000000000000a-00ff-n",
    ])
      expect(() => parseHlc(bad)).toThrow(TypeError);
  });
});
