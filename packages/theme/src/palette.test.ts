import { describe, expect, it } from "vitest";

import {
  BRAND_MIN_CHROMA,
  brandPalette,
  neutralPalette,
  neutralVariantPalette,
  palettesFor,
  statusPalette,
  tone,
  toneOf,
} from "./palette.ts";

describe("palette", () => {
  it("maps tone 0 and 100 to black and white", () => {
    const palette = palettesFor("#0e7c66").brand;
    expect(tone(palette, 0)).toBe("#000000");
    expect(tone(palette, 100)).toBe("#ffffff");
  });

  it("returns lowercase #rrggbb", () => {
    expect(tone(palettesFor("#0e7c66").brand, 40)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("rejects tones outside integers 0 to 100", () => {
    const palette = palettesFor("#0e7c66").brand;
    expect(() => tone(palette, 101)).toThrow(RangeError);
    expect(() => tone(palette, -1)).toThrow(RangeError);
    expect(() => tone(palette, 40.5)).toThrow(RangeError);
  });

  it("reads HCT tone of a color", () => {
    expect(toneOf("#000000")).toBeCloseTo(0, 5);
    expect(toneOf("#ffffff")).toBeCloseTo(100, 5);
  });

  it("keeps a minimum chroma for the brand palette even for a grey seed", () => {
    expect(BRAND_MIN_CHROMA).toBe(24);
    const grey = palettesFor("#808080").brand;
    // A grey seed has near-zero chroma; the floor makes its tones tinted, so the mid tone is not grey.
    const mid = tone(grey, 50);
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(mid.slice(i, i + 2), 16));
    expect(Math.max(r ?? 0, g ?? 0, b ?? 0) - Math.min(r ?? 0, g ?? 0, b ?? 0)).toBeGreaterThan(0);
  });

  it("memoizes palettes per seed and keeps the cache bounded", () => {
    const first = palettesFor("#123456");
    expect(palettesFor("#123456")).toBe(first);
    for (let i = 0; i < 40; i++) {
      palettesFor(`#${(i * 4099 + 17).toString(16).padStart(6, "0").slice(0, 6)}`);
    }
    expect(palettesFor("#123456")).toBeDefined();
  });
});

describe("named palette builders", () => {
  it("builds brand, neutral, neutral-variant and status palettes with their chroma rules", () => {
    const seed = "#0e7c66";
    expect(brandPalette(seed).chroma).toBeGreaterThanOrEqual(BRAND_MIN_CHROMA);
    expect(neutralPalette(seed).chroma).toBe(6);
    expect(neutralVariantPalette(seed).chroma).toBe(10);
    expect(statusPalette("danger").chroma).toBeGreaterThanOrEqual(BRAND_MIN_CHROMA);
    expect(statusPalette("info")).toBe(statusPalette("info"));
    expect(palettesFor(seed).neutral.chroma).toBe(6);
  });
});
