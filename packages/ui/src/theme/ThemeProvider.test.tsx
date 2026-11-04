import { act, renderHook } from "@testing-library/react";
import { PLATFORM_THEME, SAMPLE_THEMES, resolveTheme, toNativeTheme } from "@wise-biz/theme";
import { describe, expect, it, vi } from "vitest";

import { TEST_THEME } from "../../test/render.tsx";

import { ThemeProvider, resolveEffectiveMode, useTheme, useThemeMode } from "./ThemeProvider.tsx";

import type { ModePreference } from "./ThemeProvider.tsx";
import type { ReactNode } from "react";

const DARK_ONLY = resolveTheme({ platform: SAMPLE_THEMES[1] ?? PLATFORM_THEME });
const LIGHT_ONLY = resolveTheme({ platform: SAMPLE_THEMES[2] ?? PLATFORM_THEME });

function wrapperFor(
  theme: typeof TEST_THEME,
  mode?: ModePreference,
  onModeChange?: (m: ModePreference) => void,
) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <ThemeProvider theme={theme} mode={mode} onModeChange={onModeChange}>
        {children}
      </ThemeProvider>
    );
  };
}

describe("resolveEffectiveMode", () => {
  it("returns the only available mode regardless of preference", () => {
    expect(resolveEffectiveMode(DARK_ONLY, "light", "light")).toBe("dark");
    expect(resolveEffectiveMode(LIGHT_ONLY, "dark", "dark")).toBe("light");
  });

  it("uses an explicit preference when both modes are available", () => {
    expect(resolveEffectiveMode(TEST_THEME, "dark", "light")).toBe("dark");
    expect(resolveEffectiveMode(TEST_THEME, "light", "dark")).toBe("light");
  });

  it("follows the device scheme for system, else the store default", () => {
    expect(resolveEffectiveMode(TEST_THEME, "system", "dark")).toBe("dark");
    expect(resolveEffectiveMode(TEST_THEME, "system", "light")).toBe("light");
    expect(resolveEffectiveMode(TEST_THEME, "system", null)).toBe(TEST_THEME.modes.default);
    expect(resolveEffectiveMode(TEST_THEME, "system", undefined)).toBe(TEST_THEME.modes.default);
  });
});

describe("ThemeProvider", () => {
  it("throws a clear error outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useTheme())).toThrow(/inside <ThemeProvider>/);
    expect(() => renderHook(() => useThemeMode())).toThrow(/inside <ThemeProvider>/);
    spy.mockRestore();
  });

  it("ignores an unavailable preference for a dark-only store and disables toggling", () => {
    const { result } = renderHook(() => useThemeMode(), {
      wrapper: wrapperFor(DARK_ONLY, "light"),
    });
    expect(result.current.mode).toBe("dark");
    expect(result.current.available).toEqual(["dark"]);
    expect(result.current.canToggle).toBe(false);
    act(() => {
      result.current.setPreference("light");
    });
    expect(result.current.mode).toBe("dark");
  });

  it("disables toggling for a light-only store", () => {
    const { result } = renderHook(() => useThemeMode(), { wrapper: wrapperFor(LIGHT_ONLY) });
    expect(result.current.mode).toBe("light");
    expect(result.current.canToggle).toBe(false);
  });

  it("switches between modes with setPreference and returns the other mode's native theme", () => {
    const onModeChange = vi.fn();
    const { result } = renderHook(() => ({ theme: useTheme(), mode: useThemeMode() }), {
      wrapper: wrapperFor(TEST_THEME, undefined, onModeChange),
    });
    expect(result.current.mode.canToggle).toBe(true);
    const lightBg = result.current.theme.color.canvas;
    act(() => {
      result.current.mode.setPreference("dark");
    });
    expect(result.current.mode.mode).toBe("dark");
    expect(result.current.theme.mode).toBe("dark");
    expect(result.current.theme.color.canvas).not.toBe(lightBg);
    // Web adds a sans-serif fallback stack to each family; every other token is the theme package's object.
    const raw = toNativeTheme(TEST_THEME, "dark");
    expect(result.current.theme.color).toBe(raw.color);
    expect(result.current.theme.fontFamily.body).toMatch(
      new RegExp(`^"${raw.fontFamily.body}", .*sans-serif$`),
    );
    expect(onModeChange).toHaveBeenCalledWith("dark");
  });

  it("keeps the controlled preference until the owner changes it", () => {
    const onModeChange = vi.fn();
    const { result, rerender } = renderHook(() => useThemeMode(), {
      wrapper: wrapperFor(TEST_THEME, "light", onModeChange),
    });
    act(() => {
      result.current.setPreference("dark");
    });
    expect(result.current.mode).toBe("light");
    expect(onModeChange).toHaveBeenCalledWith("dark");
    rerender();
    expect(result.current.preference).toBe("light");
  });

  it("writes the effective mode to the document dataset", () => {
    renderHook(() => useTheme(), { wrapper: wrapperFor(TEST_THEME, "dark") });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
