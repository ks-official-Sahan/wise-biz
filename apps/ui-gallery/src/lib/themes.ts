import { PLATFORM_THEME, SAMPLE_THEMES, resolveTheme } from "@wise-biz/theme";

import type { ThemeId } from "./urlState.ts";
import type { ResolvedTheme, ThemeInput } from "@wise-biz/theme";

function sampleNamed(name: string): ThemeInput {
  const found = SAMPLE_THEMES.find((sample) => sample.name === name);
  if (found === undefined)
    throw new Error(`Sample theme "${name}" is missing from @wise-biz/theme.`);
  return found;
}

const TENANTS: Readonly<Record<Exclude<ThemeId, "platform">, ThemeInput>> = {
  "kade-cafe": sampleNamed("Kade Cafe"),
  "lanka-hardware": sampleNamed("Lanka Hardware"),
  "nila-pharmacy": sampleNamed("Nila Pharmacy"),
};

const resolved = new Map<ThemeId, ResolvedTheme>();

/** Resolved theme per gallery theme id. Resolution is pure, so the result is cached per id. */
export function themeFor(id: ThemeId): ResolvedTheme {
  const hit = resolved.get(id);
  if (hit !== undefined) return hit;
  const tenant = id === "platform" ? undefined : TENANTS[id];
  const theme = resolveTheme(
    tenant === undefined ? { platform: PLATFORM_THEME } : { platform: PLATFORM_THEME, tenant },
  );
  resolved.set(id, theme);
  return theme;
}
