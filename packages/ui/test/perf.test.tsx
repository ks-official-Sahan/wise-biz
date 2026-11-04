import { act, render } from "@testing-library/react";
import { money } from "@wise-biz/money";
import { describe, expect, it } from "vitest";

import { Button } from "../src/components/Button.tsx";
import { MoneyText } from "../src/components/MoneyText.tsx";
import { ThemeProvider } from "../src/theme/ThemeProvider.tsx";

import { TEST_THEME } from "./render.tsx";

import type { ModePreference } from "../src/theme/ThemeProvider.tsx";

const ROWS = Array.from({ length: 200 }, (_, index) => index);

function Tree() {
  return (
    <>
      {ROWS.map((index) => (
        <div key={index}>
          <Button label={`Add ${String(index)}`} onPress={() => undefined} variant="secondary" />
          <MoneyText value={money(index * 100, "LKR")} locale="en" />
        </div>
      ))}
    </>
  );
}

// One stable element for the subtree: a theme switch re-renders the consumers of the theme context,
// not the whole parent tree. That is the path a real mode toggle takes.
const TREE = <Tree />;

function themed(mode: ModePreference) {
  return (
    <ThemeProvider theme={TEST_THEME} mode={mode}>
      {TREE}
    </ThemeProvider>
  );
}

// Wall-clock budget: meaningless under turbo's parallel `check` load (measured 378 ms there vs 44 ms alone), so it
// runs only through `pnpm -F @wise-biz/ui test:perf` (vitest --mode perf) on an idle machine or a CI perf job.
const SKIP =
  (import.meta as ImportMeta & { readonly env: { readonly MODE: string } }).env.MODE !== "perf";

describe("theme switch performance", () => {
  it.skipIf(SKIP)("re-renders a 200-control tree in under 100 ms (median of 5)", () => {
    const { rerender } = render(themed("light"));
    let mode: ModePreference = "light";
    // Warm-up pair: the first switch builds the dark theme, its style sheets and the RNW style classes once.
    // Users switch many times per shift, so the steady-state switch is what the budget applies to.
    let coldMs = 0;
    for (let warm = 0; warm < 2; warm += 1) {
      mode = mode === "light" ? "dark" : "light";
      const start = performance.now();
      act(() => {
        rerender(themed(mode));
      });
      if (warm === 0) coldMs = performance.now() - start;
    }
    const samples: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      mode = mode === "light" ? "dark" : "light";
      const start = performance.now();
      act(() => {
        rerender(themed(mode));
      });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[2] ?? Number.POSITIVE_INFINITY;
    console.info(
      `theme switch: cold ${coldMs.toFixed(1)} ms; warm median ${median.toFixed(1)} ms, samples ${samples.map((s) => s.toFixed(1)).join(", ")}`,
    );
    expect(median).toBeLessThan(100);
  });
});
