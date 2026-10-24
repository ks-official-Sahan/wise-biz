import { scalesFor } from "@wise-biz/theme";

const WEIGHTS = scalesFor("comfortable").weight;

/** RN spells weights as strings. Keys are the scale values, so a changed scale fails to compile here. */
const WEIGHT_NAME = { 400: "400", 500: "500" } as const;

/**
 * Font weights as RN strings. NativeTheme does not carry weights yet, so they come from the same
 * scale table the theme package uses.
 */
export const FONT_WEIGHT = {
  regular: WEIGHT_NAME[WEIGHTS.regular],
  medium: WEIGHT_NAME[WEIGHTS.medium],
};

/** Tabular figures for money and counts. */
export const TABULAR_NUMS: readonly ["tabular-nums"] = ["tabular-nums"];

/** Line height in dp for a font size and a theme line-height ratio. */
export function lineHeightFor(fontSize: number, ratio: number): number {
  return Math.round(fontSize * ratio);
}
