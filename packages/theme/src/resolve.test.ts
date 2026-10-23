import { describe, expect, it } from "vitest";

import { PLATFORM_THEME, SAMPLE_THEMES } from "./defaults.ts";
import { resolveTheme } from "./resolve.ts";

import type { BranchOverride, TerminalPrefs, ThemeInput } from "./schema.ts";

const platform = (): ThemeInput => structuredClone(PLATFORM_THEME);

const sample = (index: number): ThemeInput => {
  const theme = SAMPLE_THEMES[index];
  if (theme === undefined) throw new Error(`sample ${String(index)} missing`);
  return structuredClone(theme);
};

describe("resolveTheme", () => {
  it("gives the same id and a deep-equal result for the same input", () => {
    const a = resolveTheme({ platform: platform() });
    const b = resolveTheme({ platform: platform() });
    expect(a.id).toBe(b.id);
    expect(a).toEqual(b);
    expect(a).toBe(b);
  });

  it("changes the id and the accent when a branch changes the seed", () => {
    const base = resolveTheme({ platform: platform() });
    const branch = resolveTheme({ platform: platform(), branch: { brand: { seed: "#1d4ed8" } } });
    expect(branch.id).not.toBe(base.id);
    expect(branch.seeds.light).toBe("#1d4ed8");
    expect(branch.tokens.light?.color.accent).not.toBe(base.tokens.light?.color.accent);
  });

  it("applies the terminal layer to density and left-handed only", () => {
    const theme = resolveTheme({
      platform: platform(),
      terminal: { density: "compact", leftHanded: true },
    });
    expect(theme.density).toBe("compact");
    expect(theme.leftHanded).toBe(true);
    expect(theme.scales.control.control).toBe(44);
    expect(theme.seeds.light).toBe("#0e7c66");
  });

  it("changes the id when only the terminal left-handed flag changes", () => {
    const right = resolveTheme({ platform: platform() });
    const left = resolveTheme({ platform: platform(), terminal: { leftHanded: true } });
    expect(left.id).not.toBe(right.id);
    expect(right.leftHanded).toBe(false);
  });

  it("rejects terminal prefs that try to set brand or other fields", () => {
    const hostile = { brand: { seed: "#000000" } } as unknown as TerminalPrefs;
    expect(() => resolveTheme({ platform: platform(), terminal: hostile })).toThrow();
  });

  it("returns a frozen result with frozen tokens", () => {
    const theme = resolveTheme({ platform: platform() });
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.tokens)).toBe(true);
    expect(Object.isFrozen(theme.tokens.light?.color)).toBe(true);
    expect(Object.isFrozen(theme.tokens.light?.component.button.primary)).toBe(true);
  });

  it("produces no light tokens for a dark-only theme", () => {
    const theme = resolveTheme({ platform: sample(1) });
    expect(theme.tokens.light).toBeUndefined();
    expect(theme.tokens.dark).toBeDefined();
    expect(theme.modes.available).toEqual(["dark"]);
  });

  it("lets a tenant replace the platform seed and drops platform seed overrides", () => {
    const theme = resolveTheme({ platform: platform(), tenant: sample(1) });
    expect(theme.seeds.dark).toBe("#ca8a04");
    expect(theme.name).toBe("Lanka Hardware");
  });

  it("drops overrides for modes the merged theme does not offer", () => {
    const withLightAccent = platform();
    withLightAccent.overrides = { light: { accent: "#9be3d4" } };
    const theme = resolveTheme({ platform: withLightAccent, tenant: sample(1) });
    expect(theme.modes.available).toEqual(["dark"]);
    expect(theme.tokens.light).toBeUndefined();
  });

  it("keeps an explicit seed override supplied by the branch", () => {
    const theme = resolveTheme({
      platform: platform(),
      branch: { brand: { seed: "#1d4ed8" }, overrides: { dark: { seed: "#112233" } } },
    });
    expect(theme.seeds.dark).toBe("#112233");
    expect(theme.seeds.light).toBe("#1d4ed8");
  });

  it("keeps non-seed overrides when a branch only sets brand", () => {
    const withCanvas = platform();
    withCanvas.overrides = { light: { canvas: "#fafafa", seed: "#222222" } };
    const theme = resolveTheme({ platform: withCanvas, branch: { brand: { seed: "#1d4ed8" } } });
    expect(theme.tokens.light?.color.canvas).toBe("#fafafa");
    expect(theme.seeds.light).toBe("#1d4ed8");
  });

  it("keeps the parent's seed overrides when a branch sets no brand", () => {
    const theme = resolveTheme({ platform: platform(), branch: { density: "compact" } });
    expect(theme.seeds.dark).toBe("#c98a12");
    expect(theme.density).toBe("compact");
  });

  it("rejects a branch whose default mode is not available after merge", () => {
    expect(() =>
      resolveTheme({
        platform: platform(),
        branch: { modes: { available: ["dark"], default: "light" } },
      }),
    ).toThrow();
  });

  it("keeps the memo bounded and still resolves the same theme after eviction", () => {
    const first = resolveTheme({ platform: platform() });
    for (let i = 1; i <= 40; i++) {
      const seed = `#${(i * 65_537).toString(16).padStart(6, "0")}`;
      resolveTheme({ platform: platform(), branch: { brand: { seed } } });
    }
    const again = resolveTheme({ platform: platform() });
    expect(again.id).toBe(first.id);
    expect(again).toEqual(first);
  });
});

describe("resolveTheme layering edges", () => {
  it("applies a branch brand to a parent that has no overrides", () => {
    const bare = platform();
    delete bare.overrides;
    const theme = resolveTheme({ platform: bare, branch: { brand: { seed: "#1d4ed8" } } });
    expect(theme.seeds.light).toBe("#1d4ed8");
    expect(theme.seeds.dark).toBe("#1d4ed8");
  });

  it("merges a tenant onto a parent with no overrides", () => {
    const bare = platform();
    delete bare.overrides;
    const theme = resolveTheme({ platform: bare, tenant: sample(0) });
    expect(theme.name).toBe("Kade Cafe");
    expect(theme.seeds.light).toBe("#c2410c");
  });

  it("ignores branch keys that are explicitly undefined", () => {
    const branch = { density: undefined } as unknown as BranchOverride;
    const theme = resolveTheme({ platform: platform(), branch });
    expect(theme.density).toBe("comfortable");
  });
});
