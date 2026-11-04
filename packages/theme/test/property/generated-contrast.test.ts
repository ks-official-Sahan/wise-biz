import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { PLATFORM_THEME } from "../../src/defaults.ts";
import { resolveTheme } from "../../src/resolve.ts";
import { validateTheme } from "../../src/validate.ts";

import type { Density, ThemeInput } from "../../src/schema.ts";

fc.configureGlobal({ seed: 42, numRuns: 300 });

const seedArb = fc
  .integer({ min: 0, max: 0xffffff })
  .map((value) => `#${value.toString(16).padStart(6, "0")}`);

const modesArb: fc.Arbitrary<ThemeInput["modes"]> = fc.constantFrom(
  { available: ["light"], default: "light" },
  { available: ["dark"], default: "dark" },
  { available: ["light", "dark"], default: "light" },
  { available: ["light", "dark"], default: "dark" },
);

const densityArb = fc.constantFrom<Density>("compact", "comfortable");

const themeArb = fc
  .tuple(seedArb, modesArb, densityArb)
  .map(([seed, modes, density]): ThemeInput => {
    const input: ThemeInput = structuredClone(PLATFORM_THEME);
    delete input.overrides;
    input.brand = { seed };
    input.modes = modes;
    input.density = density;
    return input;
  });

describe("generated theme contrast (property)", () => {
  it("any seed and modes config yields a theme with zero contrast issues", () => {
    fc.assert(
      fc.property(themeArb, (theme) => {
        expect(validateTheme(resolveTheme({ platform: theme }))).toEqual([]);
      }),
    );
  });
});
