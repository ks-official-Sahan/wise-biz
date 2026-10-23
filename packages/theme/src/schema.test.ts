import { describe, expect, it } from "vitest";

import { PLATFORM_THEME } from "./defaults.ts";
import {
  BranchOverrideSchema,
  parseTerminalPrefs,
  parseThemeInput,
  safeParseThemeInput,
} from "./schema.ts";

const base = () => structuredClone(PLATFORM_THEME);

describe("theme schema", () => {
  it("rejects a default mode that is not available", () => {
    const input = { ...base(), modes: { available: ["light"], default: "dark" } };
    expect(safeParseThemeInput(input).success).toBe(false);
  });

  it("rejects overrides for a mode that is not available", () => {
    const input = { ...base(), modes: { available: ["light"], default: "light" } };
    const result = safeParseThemeInput(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "overrides.dark")).toBe(
      true,
    );
  });

  it("rejects unknown keys such as status colors in overrides", () => {
    const input = { ...base(), overrides: { light: { danger: "#ff0000" } } };
    expect(safeParseThemeInput(input).success).toBe(false);
  });

  it("rejects unknown top-level keys such as a font size", () => {
    expect(safeParseThemeInput({ ...base(), fontSize: { md: 12 } }).success).toBe(false);
  });

  it("accepts hex and DTCG color objects for seeds and overrides", () => {
    const input = {
      ...base(),
      brand: { seed: { colorSpace: "srgb", components: [0.055, 0.486, 0.4], hex: "#0e7c66" } },
      overrides: { light: { accent: "#9be3d4" } },
    };
    expect(parseThemeInput(input).brand.seed).toBeDefined();
  });

  it("rejects a name longer than 60 characters and an empty name", () => {
    expect(safeParseThemeInput({ ...base(), name: "" }).success).toBe(false);
    expect(safeParseThemeInput({ ...base(), name: "x".repeat(61) }).success).toBe(false);
  });

  it("rejects a wrong version and unknown font families", () => {
    expect(safeParseThemeInput({ ...base(), version: 2 }).success).toBe(false);
    expect(
      safeParseThemeInput({ ...base(), font: { body: "comic", numeric: "geist-mono" } }).success,
    ).toBe(false);
  });

  it("parses branch overrides as a partial document without version and name", () => {
    expect(BranchOverrideSchema.safeParse({ brand: { seed: "#1d4ed8" } }).success).toBe(true);
    expect(BranchOverrideSchema.safeParse({ name: "Branch" }).success).toBe(false);
  });

  it("accepts terminal density and left-handed prefs only", () => {
    expect(parseTerminalPrefs({ density: "compact", leftHanded: true })).toEqual({
      density: "compact",
      leftHanded: true,
    });
    expect(() => parseTerminalPrefs({ brand: { seed: "#000000" } })).toThrow();
  });
});
