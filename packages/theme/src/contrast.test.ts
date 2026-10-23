import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { REQUIRED, contrastRatio, meetsContrast, relativeLuminance } from "./contrast.ts";

describe("contrast", () => {
  it("black on white is 21", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
  });

  it("gray 777777 on white fails text AA, 767676 passes", () => {
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("is symmetric and never below 1", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffff }),
        fc.integer({ min: 0, max: 0xffffff }),
        (a, b) => {
          const hexA = `#${a.toString(16).padStart(6, "0")}`;
          const hexB = `#${b.toString(16).padStart(6, "0")}`;
          const ratio = contrastRatio(hexA, hexB);
          expect(ratio).toBe(contrastRatio(hexB, hexA));
          expect(ratio).toBeGreaterThanOrEqual(1);
          expect(ratio).toBeLessThanOrEqual(21);
        },
      ),
    );
  });

  it("uses the 0.04045 linear threshold for dark channels", () => {
    // 0x0a = 10/255 = 0.0392, below the threshold: linear division by 12.92.
    expect(relativeLuminance("#0a0a0a")).toBeCloseTo(10 / 255 / 12.92, 10);
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  it("exposes the required ratios and the level check", () => {
    expect(REQUIRED).toEqual({ text: 4.5, large: 3, ui: 3 });
    expect(meetsContrast("#767676", "#ffffff", "text")).toBe(true);
    expect(meetsContrast("#777777", "#ffffff", "text")).toBe(false);
    expect(meetsContrast("#777777", "#ffffff", "ui")).toBe(true);
  });
});
