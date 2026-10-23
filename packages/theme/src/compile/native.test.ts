import { describe, expect, it } from "vitest";

import { PLATFORM_THEME, SAMPLE_THEMES } from "../defaults.ts";
import { resolveTheme } from "../resolve.ts";

import { toNativeTheme } from "./native.ts";

describe("toNativeTheme", () => {
  const theme = resolveTheme({ platform: structuredClone(PLATFORM_THEME) });

  it("throws a clear error for a mode the theme does not offer", () => {
    const sample = SAMPLE_THEMES[2];
    if (sample === undefined) throw new Error("sample missing");
    const lightOnly = resolveTheme({ platform: structuredClone(sample) });
    expect(() => toNativeTheme(lightOnly, "dark")).toThrow(/not available/);
  });

  it("returns the same reference for the same theme and mode", () => {
    expect(toNativeTheme(theme, "dark")).toBe(toNativeTheme(theme, "dark"));
    expect(toNativeTheme(theme, "light")).not.toBe(toNativeTheme(theme, "dark"));
  });

  it("is frozen and carries the mode, font families and non-color scales", () => {
    const native = toNativeTheme(theme, "dark");
    expect(Object.isFrozen(native)).toBe(true);
    expect(native.mode).toBe("dark");
    expect(native.fontFamily).toEqual({ body: "Geist", numeric: "Geist Mono" });
    expect(native.target.min).toBe(48);
    expect(native.control).toEqual({ control: 52, key: 56 });
    expect(native.color.overlayOpacity).toBe(0.6);
    expect(native.leftHanded).toBe(false);
  });
});
