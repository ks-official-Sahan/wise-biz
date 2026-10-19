import { describe, expect, it } from "vitest";

import { createUuidv7, isUuidv7, timestampOf, uuidv7 } from "./uuid.ts";

function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error("index out of range");
  return v;
}

const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function seeded(seed = 1): (b: Uint8Array) => void {
  let s = seed;
  return (b) => {
    for (let i = 0; i < b.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      b[i] = s >>> 24;
    }
  };
}

describe("uuidv7", () => {
  it("has RFC 9562 format, version 7 and variant 10xx", () => {
    for (let i = 0; i < 200; i++) expect(uuidv7()).toMatch(RE);
  });

  it("embeds the current time", () => {
    const before = Date.now();
    const ts = timestampOf(uuidv7());
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThan(before + 5_000);
  });

  it("stays strictly increasing across 1e6 calls", () => {
    let prev = uuidv7();
    let ok = true;
    for (let i = 0; i < 1_000_000; i++) {
      const next = uuidv7();
      if (next <= prev) ok = false;
      prev = next;
    }
    expect(ok).toBe(true);
  });
});

describe("createUuidv7", () => {
  it("advances the virtual timestamp on counter overflow with a frozen clock", () => {
    const gen = createUuidv7({ now: () => 1_700_000_000_000, random: seeded() });
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i++) ids.push(gen());
    for (let i = 1; i < ids.length; i++) expect(at(ids, i) > at(ids, i - 1)).toBe(true);
    const first = timestampOf(at(ids, 0));
    const last = timestampOf(at(ids, ids.length - 1));
    expect(first).toBe(1_700_000_000_000);
    expect(last).toBeGreaterThan(first);
  });

  it("is deterministic for the same deps", () => {
    const a = createUuidv7({ now: () => 5, random: seeded(7) });
    const b = createUuidv7({ now: () => 5, random: seeded(7) });
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("never decreases when the clock goes backwards", () => {
    let t = 1_000_000;
    const gen = createUuidv7({ now: () => t, random: seeded(3) });
    const a = gen();
    t = 500_000;
    const b = gen();
    expect(b > a).toBe(true);
    expect(timestampOf(b)).toBe(1_000_000);
    t = 1_000_005;
    const c = gen();
    expect(c > b).toBe(true);
    expect(timestampOf(c)).toBe(1_000_005);
  });

  it("clears the top counter bit on reseed", () => {
    const gen = createUuidv7({ now: () => 42, random: (b) => b.fill(0xff) });
    const id = gen();
    // rand_a high nibble (after the version digit) has top bit clear: 0x7_
    expect(id.charAt(15)).toMatch(/[0-7]/);
  });
});

describe("isUuidv7 / timestampOf", () => {
  it("accepts lower and upper case", () => {
    const id = uuidv7();
    expect(isUuidv7(id)).toBe(true);
    expect(isUuidv7(id.toUpperCase())).toBe(true);
  });

  it("rejects non-v7 values", () => {
    expect(isUuidv7(undefined)).toBe(false);
    expect(isUuidv7(42)).toBe(false);
    expect(isUuidv7("")).toBe(false);
    expect(isUuidv7("018f0000-0000-4000-8000-000000000000")).toBe(false);
    expect(isUuidv7("018f0000-0000-7000-c000-000000000000")).toBe(false);
    expect(isUuidv7("018f00000000-7000-8000-000000000000")).toBe(false);
    expect(isUuidv7("018f0000-0000-7000-8000-00000000000g")).toBe(false);
  });

  it("round-trips timestamps", () => {
    for (const ms of [0, 1, 1_700_000_000_123, 2 ** 48 - 1]) {
      const gen = createUuidv7({ now: () => ms, random: seeded(9) });
      expect(timestampOf(gen())).toBe(ms);
    }
  });

  it("throws TypeError for non-v7", () => {
    expect(() => timestampOf("nope")).toThrow(TypeError);
  });
});
