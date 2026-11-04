import { describe, expect, it } from "vitest";

import { PLATFORM_THEME, SAMPLE_THEMES } from "./defaults.ts";
import { resolveTheme } from "./resolve.ts";
import { parseThemeInput } from "./schema.ts";
import { validateTheme } from "./validate.ts";

describe("defaults", () => {
  it("PLATFORM_THEME is a valid input with the Counter and Workshop seeds", () => {
    expect(() => parseThemeInput(PLATFORM_THEME)).not.toThrow();
    expect(PLATFORM_THEME.brand.seed).toBe("#0E7C66");
    expect(PLATFORM_THEME.overrides?.dark?.seed).toBe("#C98A12");
    expect(validateTheme(resolveTheme({ platform: PLATFORM_THEME }))).toEqual([]);
  });

  it("every SAMPLE_THEME validates with zero contrast issues", () => {
    expect(SAMPLE_THEMES).toHaveLength(3);
    for (const sample of SAMPLE_THEMES) {
      expect(() => parseThemeInput(sample)).not.toThrow();
      expect(validateTheme(resolveTheme({ platform: sample }))).toEqual([]);
    }
  });
});
