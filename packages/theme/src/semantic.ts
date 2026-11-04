import { normalizeHex } from "./color.ts";
import { meetsContrast } from "./contrast.ts";
import { CONTRAST_PAIRS } from "./pairs.ts";
import { palettesFor, tone, toneOf } from "./palette.ts";
import { OVERLAY_OPACITY, TONES, isOverridable, mapNames } from "./tokens.ts";

import type { ModeOverrides, Mode, ThemeInput } from "./schema.ts";
import type { ColorName, ModeColors, OverridableName, ToneSpec } from "./tokens.ts";

/** Brand seed for one mode: the mode's own seed override when present, else the brand seed. */
export function seedFor(input: ThemeInput, mode: Mode): string {
  const override = input.overrides?.[mode]?.seed;
  return normalizeHex(override ?? input.brand.seed);
}

function overridesFor(
  modeOverrides: ModeOverrides | undefined,
): Partial<Record<OverridableName, string>> {
  const out: Partial<Record<OverridableName, string>> = {};
  if (modeOverrides === undefined) return out;
  for (const name of ["accent", "canvas", "surface"] as const) {
    const value = modeOverrides[name];
    if (value !== undefined) out[name] = normalizeHex(value);
  }
  return out;
}

/** Direction that moves a foreground away from its background in HCT tone. */
function awayFrom(fgHex: string, bgHex: string): 1 | -1 {
  const fgTone = toneOf(fgHex);
  const bgTone = toneOf(bgHex);
  if (fgTone !== bgTone) return fgTone > bgTone ? 1 : -1;
  return bgTone < 50 ? 1 : -1;
}

/**
 * Semantic colors for one mode. Overrides replace their token as given. Generated foregrounds that
 * fail their pair move one tone at a time, away from the background, until they pass or hit 0 or 100.
 */
export function buildModeColors(input: ThemeInput, mode: Mode): ModeColors {
  const palettes = palettesFor(seedFor(input, mode));
  const overrides = overridesFor(input.overrides?.[mode]);
  const specs: Record<ColorName, ToneSpec> = { ...TONES[mode] };

  const overrideOf = (name: ColorName): string | undefined =>
    isOverridable(name) ? overrides[name] : undefined;

  const hexes = mapNames((name) => {
    const fixed = overrideOf(name);
    if (fixed !== undefined) return fixed;
    const spec = specs[name];
    return tone(palettes[spec.palette], spec.tone);
  });

  for (const pair of CONTRAST_PAIRS) {
    if (overrideOf(pair.fg) !== undefined) continue;
    if (meetsContrast(hexes[pair.fg], hexes[pair.bg], pair.level)) continue;
    const spec = specs[pair.fg];
    const palette = palettes[spec.palette];
    const step = awayFrom(hexes[pair.fg], hexes[pair.bg]);
    let current = spec.tone;
    let hex = hexes[pair.fg];
    while (!meetsContrast(hex, hexes[pair.bg], pair.level)) {
      const next = current + step;
      if (next < 0 || next > 100) break;
      current = next;
      hex = tone(palette, current);
    }
    // An overridden background may be impossible to satisfy: keep the best tone, validateTheme reports it.
    if (!meetsContrast(hex, hexes[pair.bg], pair.level) && overrideOf(pair.bg) === undefined) {
      // Palette exhausted against a generated background: last resort is the absolute end, then fail loudly.
      hex = step > 0 ? "#ffffff" : "#000000";
      if (!meetsContrast(hex, hexes[pair.bg], pair.level)) {
        throw new Error(`No passing ${pair.fg} for ${pair.bg} in ${mode} mode`);
      }
    }
    hexes[pair.fg] = hex;
    specs[pair.fg] = { palette: spec.palette, tone: current };
  }

  return Object.freeze({ ...hexes, overlayOpacity: OVERLAY_OPACITY[mode] });
}
