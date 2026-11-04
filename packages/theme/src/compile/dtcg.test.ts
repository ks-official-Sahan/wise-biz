import { describe, expect, it } from "vitest";

import { PLATFORM_THEME, SAMPLE_THEMES } from "../defaults.ts";
import { resolveTheme } from "../resolve.ts";

import { toDtcg } from "./dtcg.ts";

import type { ModeTokens } from "../resolve.ts";
import type { DtcgGroup, DtcgToken } from "./dtcg.ts";

type Node = DtcgGroup | DtcgToken | undefined;

function isToken(node: DtcgGroup | DtcgToken): node is DtcgToken {
  return "$value" in node;
}

/** Child of a DTCG group, or undefined. Tokens have no children. */
function child(node: Node, key: string): Node {
  if (node === undefined || isToken(node)) return undefined;
  return node[key];
}

function asToken(node: Node): DtcgToken {
  if (node === undefined || !isToken(node)) throw new Error("expected a DTCG token");
  return node;
}

describe("toDtcg", () => {
  const theme = resolveTheme({ platform: structuredClone(PLATFORM_THEME) });

  it("declares DTCG 2025.10 with a theme modifier and both contexts", () => {
    const doc = toDtcg(theme);
    expect(doc.resolver.version).toBe("2025.10");
    expect(Object.keys(doc.resolver.modifiers.theme.contexts).sort()).toEqual(["dark", "light"]);
    expect(doc.resolver.modifiers.theme.default).toBe("light");
    expect(doc.resolver.resolutionOrder).toEqual([
      { $ref: "#/sets/base" },
      { $ref: "#/modifiers/theme" },
    ]);
  });

  it("writes color tokens as sRGB color objects with hex", () => {
    const doc = toDtcg(theme);
    const accent = asToken(child(child(doc.tokens.light, "color"), "accent"));
    expect(accent.$type).toBe("color");
    const value = accent.$value as { colorSpace: string; components: number[]; hex: string };
    expect(value.colorSpace).toBe("srgb");
    expect(value.components).toHaveLength(3);
    expect(value.hex).toBe(theme.tokens.light?.color.accent);
  });

  it("writes dimensions and durations with units", () => {
    const doc = toDtcg(theme);
    expect(asToken(child(child(doc.tokens.base, "motion"), "press")).$value).toEqual({
      value: 140,
      unit: "ms",
    });
    expect(asToken(child(child(doc.tokens.base, "radius"), "card")).$value).toEqual({
      value: 12,
      unit: "px",
    });
  });

  it("includes only the available modes as contexts", () => {
    const sample = SAMPLE_THEMES[2];
    if (sample === undefined) throw new Error("sample missing");
    const doc = toDtcg(resolveTheme({ platform: structuredClone(sample) }));
    expect(Object.keys(doc.resolver.modifiers.theme.contexts)).toEqual(["light"]);
    expect(doc.tokens.dark).toBeUndefined();
  });
});

describe("toDtcg with missing tokens", () => {
  it("skips an available mode that has no tokens", () => {
    const base = resolveTheme({ platform: structuredClone(PLATFORM_THEME) });
    const tokens: { light?: ModeTokens; dark?: ModeTokens } = { ...base.tokens };
    delete tokens.dark;
    const doc = toDtcg({ ...base, tokens });
    expect(doc.tokens.dark).toBeUndefined();
    expect(Object.keys(doc.resolver.modifiers.theme.contexts)).toEqual(["light"]);
  });
});
