import { describe, expect, it } from "vitest";

import { PLATFORM_THEME, SAMPLE_THEMES } from "../defaults.ts";
import { resolveTheme } from "../resolve.ts";

import { toCssVariables } from "./css.ts";

import type { ModeTokens } from "../resolve.ts";

describe("toCssVariables", () => {
  const both = () => resolveTheme({ platform: structuredClone(PLATFORM_THEME) });

  it("emits both mode selectors and the prefers-color-scheme block", () => {
    const css = toCssVariables(both());
    expect(css).toContain(':root,[data-theme="light"]{color-scheme:light;');
    expect(css).toContain('[data-theme="dark"]{color-scheme:dark;');
    expect(css).toContain(
      "@media (prefers-color-scheme: dark){:root:not([data-theme]){color-scheme:dark;",
    );
  });

  it("is deterministic across resolves", () => {
    const css = toCssVariables(both());
    expect(toCssVariables(both())).toBe(css);
  });

  it("emits the named color, space, radius, font-size and motion variables", () => {
    const css = toCssVariables(both());
    expect(css).toContain("--wb-color-surface-raised:");
    expect(css).toContain("--wb-color-on-danger:");
    expect(css).toContain("--wb-color-overlay-opacity:0.4");
    expect(css).toContain("--wb-space-0:0px");
    expect(css).toContain("--wb-space-11:64px");
    expect(css).toContain("--wb-radius-pill:999px");
    expect(css).toContain("--wb-font-size-2xl:32px");
    expect(css).toContain("--wb-motion-press:140ms");
    expect(css).toContain("--wb-motion-ease-out:cubic-bezier(0.23,1,0.32,1)");
    expect(css).toContain("--wb-motion-ease-sheet:cubic-bezier(0.32,0.72,0,1)");
  });

  it("emits color-scheme once for a single-mode theme on :root", () => {
    const sample = SAMPLE_THEMES[2];
    if (sample === undefined) throw new Error("sample missing");
    const css = toCssVariables(resolveTheme({ platform: structuredClone(sample) }));
    expect(css.startsWith(":root{color-scheme:light;")).toBe(true);
    expect(css).not.toContain("data-theme");
    expect(css).not.toContain("@media");
  });

  it("uses dark as the selector default when the default mode is dark", () => {
    const theme = resolveTheme({
      platform: structuredClone(PLATFORM_THEME),
      branch: { modes: { available: ["light", "dark"], default: "dark" } },
    });
    const css = toCssVariables(theme);
    expect(css).toContain(':root,[data-theme="dark"]{color-scheme:dark;');
    expect(css).toContain(
      "@media (prefers-color-scheme: light){:root:not([data-theme]){color-scheme:light;",
    );
  });
});

describe("toCssVariables with missing tokens", () => {
  it("throws when the default mode has no tokens", () => {
    const base = resolveTheme({ platform: structuredClone(PLATFORM_THEME) });
    const tokens: { light?: ModeTokens; dark?: ModeTokens } = { ...base.tokens };
    delete tokens.light;
    const broken = { ...base, tokens };
    expect(() => toCssVariables(broken)).toThrow(/Default mode light has no tokens/);
  });

  it("throws when the other mode has no tokens", () => {
    const base = resolveTheme({ platform: structuredClone(PLATFORM_THEME) });
    const tokens: { light?: ModeTokens; dark?: ModeTokens } = { ...base.tokens };
    delete tokens.dark;
    const broken = { ...base, tokens };
    expect(() => toCssVariables(broken)).toThrow(/Mode dark has no tokens/);
  });
});
