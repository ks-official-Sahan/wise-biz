import { contrastRatio, REQUIRED } from "./contrast.ts";
import { CONTRAST_PAIRS } from "./pairs.ts";
import { palettesFor, tone, toneOf } from "./palette.ts";
import { TONES, isOverridable } from "./tokens.ts";

import type { ContrastLevel } from "./contrast.ts";
import type { ContrastPair } from "./pairs.ts";
import type { PaletteKind } from "./palette.ts";
import type { ResolvedTheme } from "./resolve.ts";
import type { Mode } from "./schema.ts";
import type { ColorName, ModeColors } from "./tokens.ts";
import type { TonalPalette } from "@material/material-color-utilities";

export interface ContrastIssue {
  readonly mode: Mode;
  readonly fg: ColorName;
  readonly bg: ColorName;
  readonly ratio: number;
  readonly required: number;
  readonly suggestion?: string;
}

/** Closest tone (to `targetTone`) in `palette` that passes `level` against `fixed`. Ties go to the lower tone. */
function nearestPassingTone(
  palette: TonalPalette,
  targetTone: number,
  fixed: string,
  level: ContrastLevel,
): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let t = 0; t <= 100; t++) {
    const hex = tone(palette, t);
    if (contrastRatio(hex, fixed) < REQUIRED[level]) continue;
    const distance = Math.abs(t - targetTone);
    if (distance < bestDistance) {
      best = hex;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Replacement for a failing token that keeps the other side of the pair fixed. Overridable backgrounds
 * (accent, canvas, surface) are re-picked from the brand palette; generated foregrounds from their own.
 */
function suggestFix(
  mode: Mode,
  seed: string,
  pair: ContrastPair,
  colors: ModeColors,
): string | undefined {
  const replaceBg = isOverridable(pair.bg);
  const target = replaceBg ? pair.bg : pair.fg;
  const fixed = replaceBg ? colors[pair.fg] : colors[pair.bg];
  const kind: PaletteKind = replaceBg ? "brand" : TONES[mode][pair.fg].palette;
  return nearestPassingTone(palettesFor(seed)[kind], toneOf(colors[target]), fixed, pair.level);
}

/** Contrast issues for every mode of a resolved theme. Empty array means the theme is valid. */
export function validateTheme(theme: ResolvedTheme): ContrastIssue[] {
  const issues: ContrastIssue[] = [];
  for (const mode of ["light", "dark"] as const) {
    const tokens = theme.tokens[mode];
    const seed = theme.seeds[mode];
    if (tokens === undefined || seed === undefined) continue;
    for (const pair of CONTRAST_PAIRS) {
      const ratio = contrastRatio(tokens.color[pair.fg], tokens.color[pair.bg]);
      const required = REQUIRED[pair.level];
      if (ratio >= required) continue;
      const suggestion = suggestFix(mode, seed, pair, tokens.color);
      issues.push({
        mode,
        fg: pair.fg,
        bg: pair.bg,
        ratio,
        required,
        ...(suggestion === undefined ? {} : { suggestion }),
      });
    }
  }
  return issues;
}
