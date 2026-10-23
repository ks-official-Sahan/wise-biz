import { describe, expect, it } from "vitest";

import { toNativeTheme } from "../../src/compile/native.ts";
import { PLATFORM_THEME } from "../../src/defaults.ts";
import { resolveTheme } from "../../src/resolve.ts";

import type { ThemeInput } from "../../src/schema.ts";

const RUNS = 20;
const BUDGET_MS = 20;

/** Each run uses a seed never seen before, so every resolve misses the memo and does the full work. */
function coldRun(index: number): number {
  const seed = `#${(0x0e7c66 + index * 7919).toString(16).padStart(6, "0").slice(-6)}`;
  const input: ThemeInput = structuredClone(PLATFORM_THEME);
  delete input.overrides;
  input.brand = { seed };
  const start = Date.now();
  const theme = resolveTheme({ platform: input });
  toNativeTheme(theme, "light");
  toNativeTheme(theme, "dark");
  return Date.now() - start;
}

describe("resolve + native perf", () => {
  it("resolves and compiles native for both modes of a new theme in under 20 ms (median of 20)", () => {
    for (let warm = 0; warm < 3; warm++) coldRun(10_000 + warm);
    const samples = Array.from({ length: RUNS }, (_, index) => coldRun(index)).sort(
      (a, b) => a - b,
    );
    const median = samples[Math.floor(RUNS / 2)] ?? Number.POSITIVE_INFINITY;
    expect(median).toBeLessThan(BUDGET_MS);
  });
});
