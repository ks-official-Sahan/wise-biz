import type { ContrastLevel } from "./contrast.ts";
import type { ColorName } from "./tokens.ts";

export interface ContrastPair {
  readonly fg: ColorName;
  readonly bg: ColorName;
  readonly level: ContrastLevel;
}

/** Every foreground/background pair the validator checks, in one mode. Order is the report order. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "text", bg: "canvas", level: "text" },
  { fg: "text", bg: "surface", level: "text" },
  { fg: "textMuted", bg: "surface", level: "text" },
  { fg: "textMuted", bg: "canvas", level: "text" },
  { fg: "textOnAccent", bg: "accent", level: "text" },
  { fg: "accentText", bg: "surface", level: "text" },
  { fg: "accentText", bg: "canvas", level: "text" },
  { fg: "focusRing", bg: "canvas", level: "ui" },
  { fg: "focusRing", bg: "surface", level: "ui" },
  { fg: "borderStrong", bg: "surface", level: "ui" },
  { fg: "onDanger", bg: "danger", level: "text" },
  { fg: "dangerText", bg: "dangerSubtle", level: "text" },
  { fg: "dangerText", bg: "surface", level: "text" },
  { fg: "onWarning", bg: "warning", level: "text" },
  { fg: "warningText", bg: "warningSubtle", level: "text" },
  { fg: "warningText", bg: "surface", level: "text" },
  { fg: "onSuccess", bg: "success", level: "text" },
  { fg: "successText", bg: "successSubtle", level: "text" },
  { fg: "successText", bg: "surface", level: "text" },
  { fg: "onInfo", bg: "info", level: "text" },
  { fg: "infoText", bg: "infoSubtle", level: "text" },
  { fg: "infoText", bg: "surface", level: "text" },
];
