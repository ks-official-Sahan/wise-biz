import { describe, expect, it } from "vitest";

import { meetsContrast } from "./contrast.ts";
import { PLATFORM_THEME } from "./defaults.ts";
import { resolveTheme } from "./resolve.ts";
import { validateTheme } from "./validate.ts";

import type { ResolvedTheme } from "./resolve.ts";
import type { ContrastIssue } from "./validate.ts";

const platform = structuredClone(PLATFORM_THEME);

const findIssue = (issues: readonly ContrastIssue[], fg: string, bg: string) =>
  issues.find((issue) => issue.fg === fg && issue.bg === bg);

describe("validateTheme", () => {
  it("returns no issues for the platform default", () => {
    expect(validateTheme(resolveTheme({ platform }))).toEqual([]);
  });

  it("flags an accent override that fails, with a suggestion that passes when substituted", () => {
    const first = resolveTheme({
      platform: { ...platform, overrides: { light: { accent: "#9be3d4" } } },
    });
    const issue = findIssue(validateTheme(first), "textOnAccent", "accent");
    expect(issue?.mode).toBe("light");
    expect(issue?.ratio).toBeLessThan(4.5);
    expect(issue?.required).toBe(4.5);
    expect(issue?.suggestion).toMatch(/^#[0-9a-f]{6}$/);

    const fixed = resolveTheme({
      platform: { ...platform, overrides: { light: { accent: issue?.suggestion ?? "" } } },
    });
    expect(findIssue(validateTheme(fixed), "textOnAccent", "accent")).toBeUndefined();
  });

  it("suggests a passing canvas for a dark canvas override that breaks text", () => {
    const theme = resolveTheme({
      platform: { ...platform, overrides: { dark: { canvas: "#ffffff" } } },
    });
    const issue = findIssue(validateTheme(theme), "text", "canvas");
    expect(issue?.mode).toBe("dark");
    expect(issue?.suggestion).toBeDefined();
    const suggested = issue?.suggestion ?? "#ffffff";
    const tokens = theme.tokens.dark;
    expect(meetsContrast(tokens?.color.text ?? "#ffffff", suggested, "text")).toBe(true);
  });

  it("suggests a replacement for a generated foreground that somehow fails", () => {
    const base = resolveTheme({ platform });
    const light = base.tokens.light;
    if (light === undefined) throw new Error("light tokens missing");
    const broken: ResolvedTheme = {
      ...base,
      tokens: {
        ...base.tokens,
        light: { ...light, color: { ...light.color, text: "#777777" } },
      },
    };
    const issue = findIssue(validateTheme(broken), "text", "canvas");
    expect(issue?.suggestion).toBeDefined();
    expect(meetsContrast(issue?.suggestion ?? "#000000", light.color.canvas, "text")).toBe(true);
  });

  it("skips modes without tokens", () => {
    const darkOnly = structuredClone(platform);
    delete darkOnly.overrides;
    const theme = resolveTheme({
      platform: { ...darkOnly, modes: { available: ["dark"], default: "dark" } },
    });
    expect(validateTheme(theme)).toEqual([]);
  });
});

describe("validateTheme for a generated foreground", () => {
  it("replaces the generated foreground from its own palette when it fails", () => {
    const base = resolveTheme({ platform });
    const light = base.tokens.light;
    if (light === undefined) throw new Error("light tokens missing");
    const broken: ResolvedTheme = {
      ...base,
      tokens: {
        ...base.tokens,
        light: { ...light, color: { ...light.color, dangerText: "#e0e0e0" } },
      },
    };
    const issue = findIssue(validateTheme(broken), "dangerText", "dangerSubtle");
    expect(issue?.suggestion).toBeDefined();
    expect(meetsContrast(issue?.suggestion ?? "#000000", light.color.dangerSubtle, "text")).toBe(
      true,
    );
  });
});
