import { describe, expect, it } from "vitest";

import { PLATFORM_THEME } from "../defaults.ts";
import { resolveTheme } from "../resolve.ts";

import { toReceiptSettings } from "./receipt.ts";

describe("toReceiptSettings", () => {
  const theme = resolveTheme({ platform: structuredClone(PLATFORM_THEME) });

  it("gives 32 characters and 384 dots for 58 mm paper", () => {
    const settings = toReceiptSettings(theme, 58);
    expect(settings.charsPerLine).toBe(32);
    expect(settings.logo.maxWidthDots).toBe(384);
  });

  it("gives 48 characters and 576 dots for 80 mm paper", () => {
    expect(toReceiptSettings(theme, 80)).toEqual({
      charsPerLine: 48,
      headerSize: "double",
      totalBold: true,
      logo: { maxWidthDots: 576, dither: "floyd-steinberg" },
    });
  });

  it("is frozen and independent of the theme colors", () => {
    expect(Object.isFrozen(toReceiptSettings(theme, 58))).toBe(true);
    expect(toReceiptSettings(theme, 58)).toEqual(toReceiptSettings(theme, 58));
  });
});
