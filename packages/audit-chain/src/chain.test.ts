import { describe, expect, it } from "vitest";

import { GENESIS_HASH, isChainHash, link, verifyChain } from "./index.ts";

import type { ChainRow } from "./index.ts";

function build(n: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev: string = GENESIS_HASH;
  for (let i = 0; i < n; i++) {
    const payload = { seq: i, action: "sale.void", by: `u${String(i)}` };
    const hash = link(prev, payload);
    rows.push({ payload, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

const flip = (h: string): string => (h.startsWith("a") ? "b" : "a") + h.slice(1);

describe("link", () => {
  it("is deterministic, hex, and key-order independent", () => {
    const a = link(GENESIS_HASH, { a: 1, b: [1, 2], c: "x" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(link(GENESIS_HASH, { c: "x", b: [1, 2], a: 1 })).toBe(a);
    expect(link(GENESIS_HASH, { a: 2 })).not.toBe(link(GENESIS_HASH, { a: 1 }));
    expect(link(a, { a: 1 })).not.toBe(link(GENESIS_HASH, { a: 1 }));
  });
  it("rejects bad prevHash", () => {
    for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), "0".repeat(63)]) {
      expect(() => link(bad, {})).toThrow(TypeError);
    }
    expect(isChainHash(123)).toBe(false);
  });
});

describe("verifyChain", () => {
  const rows = build(6);
  const head = at(rows, 5).hash;

  it("verifies chains, including empty", () => {
    expect(verifyChain(rows)).toEqual({ ok: true, head, length: 6 });
    expect(verifyChain(rows, { expectedHead: head, expectedLength: 6 }).ok).toBe(true);
    expect(verifyChain([])).toEqual({ ok: true, head: GENESIS_HASH, length: 0 });
    const s = "1".repeat(64);
    expect(verifyChain([], { startHash: s })).toEqual({ ok: true, head: s, length: 0 });
    expect(verifyChain([], { expectedHead: head })).toEqual({
      ok: false,
      index: 0,
      reason: "head_mismatch",
    });
  });

  it.each([0, 3, 5])("detects payload edit at %i", (i) => {
    const t = rows.map((r, j) => (j === i ? { ...r, payload: { seq: 999 } } : r));
    expect(verifyChain(t)).toEqual({ ok: false, index: i, reason: "hash_mismatch" });
  });
  it.each([0, 3, 5])("detects hash edit at %i", (i) => {
    const t = rows.map((r, j) => (j === i ? { ...r, hash: flip(r.hash) } : r));
    const res = verifyChain(t);
    expect(res).toEqual({ ok: false, index: i, reason: "hash_mismatch" });
  });
  it("detects deletes", () => {
    expect(verifyChain(rows.filter((_, j) => j !== 3))).toEqual({
      ok: false,
      index: 3,
      reason: "prev_mismatch",
    });
    expect(verifyChain(rows.slice(1))).toEqual({ ok: false, index: 0, reason: "prev_mismatch" });
    const tail = rows.slice(0, 5);
    expect(verifyChain(tail).ok).toBe(true);
    expect(verifyChain(tail, { expectedHead: head })).toEqual({
      ok: false,
      index: 5,
      reason: "head_mismatch",
    });
    expect(verifyChain(tail, { expectedLength: 6 })).toEqual({
      ok: false,
      index: 5,
      reason: "length_mismatch",
    });
  });
  it("detects insert and reorder", () => {
    const forged: ChainRow = {
      payload: { x: 1 },
      prevHash: at(rows, 2).hash,
      hash: "c".repeat(64),
    };
    expect(verifyChain([...rows.slice(0, 3), forged, ...rows.slice(3)])).toEqual({
      ok: false,
      index: 3,
      reason: "hash_mismatch",
    });
    const sw = [...rows];
    [sw[1], sw[2]] = [at(sw, 2), at(sw, 1)];
    expect(verifyChain(sw)).toEqual({ ok: false, index: 1, reason: "prev_mismatch" });
  });
  it("detects wrong startHash", () => {
    expect(verifyChain(rows, { startHash: "1".repeat(64) })).toEqual({
      ok: false,
      index: 0,
      reason: "prev_mismatch",
    });
    expect(() => verifyChain(rows, { startHash: "zz" })).toThrow(TypeError);
  });
  it("flags malformed rows", () => {
    const bad = (r: Partial<Record<keyof ChainRow, unknown>>): ChainRow[] => [
      at(rows, 0),
      { ...at(rows, 1), ...r } as ChainRow,
    ];
    expect(verifyChain(bad({ hash: "xyz" }))).toEqual({ ok: false, index: 1, reason: "malformed" });
    expect(verifyChain(bad({ prevHash: 5 }))).toEqual({ ok: false, index: 1, reason: "malformed" });
    expect(verifyChain(bad({ hash: at(rows, 1).hash.toUpperCase() })).ok).toBe(false);
    expect(verifyChain(bad({ payload: { n: Number.NaN } }))).toEqual({
      ok: false,
      index: 1,
      reason: "malformed",
    });
    expect(verifyChain([null as unknown as ChainRow])).toEqual({
      ok: false,
      index: 0,
      reason: "malformed",
    });
  });
});

function at<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error("index out of range");
  return v;
}
