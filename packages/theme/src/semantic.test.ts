import { describe, expect, it } from "vitest";

import { meetsContrast } from "./contrast.ts";
import { PLATFORM_THEME } from "./defaults.ts";
import { CONTRAST_PAIRS } from "./pairs.ts";
import { palettesFor, tone, toneOf } from "./palette.ts";
import { parseThemeInput } from "./schema.ts";
import { buildModeColors, seedFor } from "./semantic.ts";
import { COLOR_NAMES } from "./tokens.ts";

import type { ThemeInput } from "./schema.ts";

const make = (patch: Partial<ThemeInput> = {}): ThemeInput =>
  parseThemeInput({ ...structuredClone(PLATFORM_THEME), ...patch });

const withoutOverrides = (patch: Partial<ThemeInput> = {}): ThemeInput => {
  const input = make(patch);
  delete input.overrides;
  return input;
};

describe("buildModeColors", () => {
  it("emits every semantic token as lowercase hex, with overlay opacity", () => {
    const light = buildModeColors(make(), "light");
    for (const name of COLOR_NAMES) {
      expect(light[name]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(light.overlayOpacity).toBe(0.4);
    expect(buildModeColors(make(), "dark").overlayOpacity).toBe(0.6);
  });

  it("generates light tones from the brand and neutral palettes", () => {
    const input = withoutOverrides();
    const palettes = palettesFor("#0e7c66");
    const light = buildModeColors(input, "light");
    expect(light.text).toBe(tone(palettes.neutral, 10));
    expect(light.accent).toBe(tone(palettes.brand, 40));
    expect(light.canvas).toBe(tone(palettes.neutral, 98));
    expect(light.overlay).toBe(tone(palettes.neutral, 2));
    expect(light.dangerText).toBe(tone(palettesFor("#b3261e").danger, 30));
  });

  it("uses the mode seed override for that mode only", () => {
    const input = make();
    expect(seedFor(input, "dark")).toBe("#c98a12");
    expect(seedFor(input, "light")).toBe("#0e7c66");
    const dark = buildModeColors(input, "dark");
    expect(dark.accent).toBe(tone(palettesFor("#c98a12").brand, 80));
  });

  it("replaces an overridden token as given", () => {
    const input = make({ overrides: { light: { accent: "#9BE3D4" } } });
    expect(buildModeColors(input, "light").accent).toBe("#9be3d4");
  });

  it("moves a generated foreground until it passes when its background is overridden", () => {
    const input = make({ overrides: { light: { canvas: "#777777" } } });
    const light = buildModeColors(input, "light");
    expect(light.canvas).toBe("#777777");
    expect(meetsContrast(light.text, light.canvas, "text")).toBe(true);
    expect(light.text).not.toBe(tone(palettesFor("#0e7c66").neutral, 10));
  });

  it("passes every contrast pair for extreme seeds in both modes", () => {
    for (const seed of ["#000000", "#ffffff", "#ffff00", "#0000ff", "#808080", "#00ffff"]) {
      const input = withoutOverrides({ brand: { seed } });
      for (const mode of ["light", "dark"] as const) {
        const colors = buildModeColors(input, mode);
        for (const pair of CONTRAST_PAIRS) {
          expect(meetsContrast(colors[pair.fg], colors[pair.bg], pair.level)).toBe(true);
        }
      }
    }
  });
});

describe("buildModeColors direction", () => {
  it("moves a foreground lighter when it equals a dark background in tone", () => {
    const textHex = tone(palettesFor("#0e7c66").neutral, 10);
    const colors = buildModeColors(make({ overrides: { light: { canvas: textHex } } }), "light");
    expect(colors.canvas).toBe(textHex);
    // Text must also pass the white surface, so no single tone can satisfy both: assert direction only.
    expect(toneOf(colors.text)).toBeGreaterThan(toneOf(textHex));
  });
});
