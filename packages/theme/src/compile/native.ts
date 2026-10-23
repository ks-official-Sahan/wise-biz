import { BODY_FONT_FAMILY, NUMERIC_FONT_FAMILY } from "../scales.ts";

import type { ComponentTokens } from "../component.ts";
import type { ResolvedTheme } from "../resolve.ts";
import type { Scales } from "../scales.ts";
import type { Mode } from "../schema.ts";
import type { ModeColors } from "../tokens.ts";

export type NativeTheme = Readonly<{
  id: string;
  mode: Mode;
  color: ModeColors;
  component: ComponentTokens;
  space: Scales["space"];
  radius: Scales["radius"];
  fontSize: Scales["fontSize"];
  lineHeight: Scales["lineHeight"];
  fontFamily: Readonly<{ body: string; numeric: string }>;
  motion: Scales["motion"];
  target: Scales["target"];
  control: Scales["control"];
  leftHanded: boolean;
}>;

/** Native objects per resolved theme. A theme is itself memoized by id, so this cache is per id too. */
const nativeCache = new WeakMap<ResolvedTheme, Partial<Record<Mode, NativeTheme>>>();

/** Frozen RN theme for one mode. Same theme and mode give the same object reference. */
export function toNativeTheme(theme: ResolvedTheme, mode: Mode): NativeTheme {
  const tokens = theme.tokens[mode];
  if (tokens === undefined) {
    throw new RangeError(`Mode "${mode}" is not available in theme ${theme.id}`);
  }
  const byMode = nativeCache.get(theme) ?? {};
  const cached = byMode[mode];
  if (cached !== undefined) return cached;

  const native: NativeTheme = Object.freeze({
    id: theme.id,
    mode,
    color: tokens.color,
    component: tokens.component,
    space: theme.scales.space,
    radius: theme.scales.radius,
    fontSize: theme.scales.fontSize,
    lineHeight: theme.scales.lineHeight,
    fontFamily: Object.freeze({
      body: BODY_FONT_FAMILY[theme.font.body],
      numeric: NUMERIC_FONT_FAMILY[theme.font.numeric],
    }),
    motion: theme.scales.motion,
    target: theme.scales.target,
    control: theme.scales.control,
    leftHanded: theme.leftHanded,
  });
  byMode[mode] = native;
  nativeCache.set(theme, byMode);
  return native;
}
