import { describe, expect, it } from "vitest";

import { commandHash, fromBase64, GENESIS_HASH, toBase64 } from "../src/chain.ts";

describe("commandHash", () => {
  // The wire contract with modules/sync (ADR 0015), computed independently with node:crypto over the RFC 8785 text. If it changes, every enrolled device breaks.
  it("matches the pinned vector", () => {
    const h = commandHash("complete_sale", 7, { id: "s1", totalMinor: 1100 }, GENESIS_HASH);
    expect(toBase64(h)).toBe("MQQcMWM0jdLbNm0TZ+vFLa42/TkmiiIaDPXyWzaRjyM=");
  });

  it("ignores meta and key order, but not type, seq, body or prev hash", () => {
    const base = commandHash("t", 1, { a: 1, b: 2 }, GENESIS_HASH);
    const meta = { deviceSeq: 1, prevHash: "x", hash: "y", signature: "z" };
    expect(commandHash("t", 1, { b: 2, a: 1, meta }, GENESIS_HASH)).toEqual(base);
    expect(commandHash("u", 1, { a: 1, b: 2 }, GENESIS_HASH)).not.toEqual(base);
    expect(commandHash("t", 2, { a: 1, b: 2 }, GENESIS_HASH)).not.toEqual(base);
    expect(commandHash("t", 1, { a: 1, b: 3 }, GENESIS_HASH)).not.toEqual(base);
    expect(commandHash("t", 1, { a: 1, b: 2 }, new Uint8Array(32).fill(1))).not.toEqual(base);
  });

  it("base64 helpers round-trip", () => {
    expect(fromBase64(toBase64(GENESIS_HASH))).toEqual(GENESIS_HASH);
  });
});
