import { describe, expect, it } from "vitest";

import {
  ColorError,
  ColorInputSchema,
  DtcgColorSchema,
  componentsToHex,
  normalizeHex,
  parseHex,
  toDtcgColor,
} from "./color.ts";

describe("color", () => {
  it("parses channel values from hex in any case", () => {
    expect(parseHex("#0E7c66")).toEqual([14, 124, 102]);
  });

  it("rejects malformed hex", () => {
    expect(() => parseHex("#fff")).toThrow(ColorError);
    expect(() => normalizeHex("teal")).toThrow(ColorError);
  });

  it("lowercases hex and derives hex from components", () => {
    expect(normalizeHex("#0E7C66")).toBe("#0e7c66");
    expect(normalizeHex({ colorSpace: "srgb", components: [0.055, 0.486, 0.4] })).toBe("#0e7c66");
  });

  it("rejects non-opaque DTCG colors as theme colors", () => {
    const translucent = { colorSpace: "srgb", components: [0, 0, 0], alpha: 0.5 };
    expect(DtcgColorSchema.safeParse(translucent).success).toBe(false);
  });

  it("builds a DTCG color object that round-trips to the same hex", () => {
    const dtcg = toDtcgColor("#0E7C66");
    expect(dtcg.colorSpace).toBe("srgb");
    expect(dtcg.hex).toBe("#0e7c66");
    expect(componentsToHex(dtcg.components)).toBe("#0e7c66");
  });

  it("accepts hex and DTCG objects in the input schema", () => {
    expect(ColorInputSchema.safeParse("#0e7c66").success).toBe(true);
    expect(ColorInputSchema.safeParse(toDtcgColor("#0e7c66")).success).toBe(true);
    expect(ColorInputSchema.safeParse("#0e7c6").success).toBe(false);
  });

  it("rejects a DTCG hex that disagrees with its components", () => {
    const bad = { colorSpace: "srgb", components: [1, 1, 1], hex: "#000000" };
    expect(ColorInputSchema.safeParse(bad).success).toBe(false);
    const good = { colorSpace: "srgb", components: [1, 1, 1], hex: "#FFFFFF" };
    expect(ColorInputSchema.safeParse(good).success).toBe(true);
  });
});
