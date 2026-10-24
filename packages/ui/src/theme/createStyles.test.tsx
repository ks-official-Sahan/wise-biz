import { renderHook } from "@testing-library/react";
import { PLATFORM_THEME, SAMPLE_THEMES, resolveTheme, toNativeTheme } from "@wise-biz/theme";
import { describe, expect, it, vi } from "vitest";

import { TEST_THEME } from "../../test/render.tsx";

import { createStyles } from "./createStyles.ts";
import { focusRingStyle } from "./focus.ts";
import { ThemeProvider } from "./ThemeProvider.tsx";
import { lineHeightFor, FONT_WEIGHT } from "./typography.ts";

import type { ReactNode } from "react";

function wrap(theme: typeof TEST_THEME, mode: "light" | "dark") {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <ThemeProvider theme={theme} mode={mode}>
        {children}
      </ThemeProvider>
    );
  };
}

describe("createStyles", () => {
  it("creates the sheet once per theme object, not once per render", () => {
    const factory = vi.fn((t: ReturnType<typeof toNativeTheme>) => ({
      box: { padding: t.space[4] },
    }));
    const useStyles = createStyles(factory);
    const wrapper = wrap(TEST_THEME, "light");
    const first = renderHook(() => useStyles(), { wrapper });
    const again = renderHook(() => useStyles(), { wrapper });
    first.rerender();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.result.current).toBe(again.result.current);
  });

  it("builds a separate sheet for the other mode", () => {
    const factory = vi.fn((t: ReturnType<typeof toNativeTheme>) => ({
      box: { padding: t.space[4] },
    }));
    const useStyles = createStyles(factory);
    const light = renderHook(() => useStyles(), { wrapper: wrap(TEST_THEME, "light") });
    const dark = renderHook(() => useStyles(), { wrapper: wrap(TEST_THEME, "dark") });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(light.result.current).not.toBe(dark.result.current);
  });

  it("builds from the theme's own tokens", () => {
    const useStyles = createStyles((t) => ({ box: { backgroundColor: t.color.canvas } }));
    const { result } = renderHook(() => useStyles(), { wrapper: wrap(TEST_THEME, "light") });
    expect(result.current.box).toEqual(
      expect.objectContaining({ backgroundColor: toNativeTheme(TEST_THEME, "light").color.canvas }),
    );
  });
});

describe("focusRingStyle", () => {
  const theme = toNativeTheme(TEST_THEME, "light");

  it("is empty when not focused", () => {
    expect(focusRingStyle(theme, false)).toEqual({});
    expect(focusRingStyle(theme, undefined)).toEqual({});
  });

  it("draws a 2 px brand ring with 2 px offset when focused", () => {
    expect(focusRingStyle(theme, true)).toEqual({
      outlineColor: theme.color.focusRing,
      outlineWidth: 2,
      outlineStyle: "solid",
      outlineOffset: 2,
    });
  });
});

describe("typography helpers", () => {
  it("rounds line heights to whole dp", () => {
    expect(lineHeightFor(16, 1.5)).toBe(24);
    expect(lineHeightFor(14, 1.25)).toBe(18);
  });

  it("maps weights to RN strings", () => {
    expect(FONT_WEIGHT).toEqual({ regular: "400", medium: "500" });
  });

  it("resolves a single-mode sample theme without a toggle", () => {
    const sample = resolveTheme({ platform: SAMPLE_THEMES[2] ?? PLATFORM_THEME });
    expect(sample.modes.available).toEqual(["light"]);
  });
});
