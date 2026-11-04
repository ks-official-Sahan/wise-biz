import type { PaletteKind } from "./palette.ts";
import type { Mode } from "./schema.ts";

/** Semantic color tokens. Each one is a tone in one palette, so contrast is checkable per pair. */
export const COLOR_NAMES = [
  "canvas",
  "surface",
  "surfaceRaised",
  "surfaceSunken",
  "border",
  "borderStrong",
  "text",
  "textMuted",
  "textOnAccent",
  "accent",
  "accentHover",
  "accentPressed",
  "accentSubtle",
  "accentText",
  "focusRing",
  "overlay",
  "danger",
  "onDanger",
  "dangerSubtle",
  "dangerText",
  "warning",
  "onWarning",
  "warningSubtle",
  "warningText",
  "success",
  "onSuccess",
  "successSubtle",
  "successText",
  "info",
  "onInfo",
  "infoSubtle",
  "infoText",
] as const;

export type ColorName = (typeof COLOR_NAMES)[number];

/** Color tokens a tenant may replace per mode. Each is a background in a contrast pair. */
export const OVERRIDABLE_NAMES = ["accent", "canvas", "surface"] as const;
export type OverridableName = (typeof OVERRIDABLE_NAMES)[number];

export function isOverridable(name: ColorName): name is OverridableName {
  return name === "accent" || name === "canvas" || name === "surface";
}

export interface ToneSpec {
  readonly palette: PaletteKind;
  readonly tone: number;
}

const t = (palette: PaletteKind, tone: number): ToneSpec => ({ palette, tone });

const LIGHT: Readonly<Record<ColorName, ToneSpec>> = {
  canvas: t("neutral", 98),
  surface: t("neutral", 99),
  surfaceRaised: t("neutral", 99),
  surfaceSunken: t("neutral", 95),
  border: t("neutralVariant", 87),
  borderStrong: t("neutralVariant", 50),
  text: t("neutral", 10),
  textMuted: t("neutralVariant", 30),
  textOnAccent: t("brand", 99),
  accent: t("brand", 40),
  accentHover: t("brand", 35),
  accentPressed: t("brand", 30),
  accentSubtle: t("brand", 92),
  accentText: t("brand", 40),
  focusRing: t("brand", 40),
  overlay: t("neutral", 2),
  danger: t("danger", 40),
  onDanger: t("danger", 99),
  dangerSubtle: t("danger", 92),
  dangerText: t("danger", 30),
  warning: t("warning", 40),
  onWarning: t("warning", 99),
  warningSubtle: t("warning", 92),
  warningText: t("warning", 30),
  success: t("success", 40),
  onSuccess: t("success", 99),
  successSubtle: t("success", 92),
  successText: t("success", 30),
  info: t("info", 40),
  onInfo: t("info", 99),
  infoSubtle: t("info", 92),
  infoText: t("info", 30),
};

const DARK: Readonly<Record<ColorName, ToneSpec>> = {
  canvas: t("neutral", 6),
  surface: t("neutral", 10),
  surfaceRaised: t("neutral", 17),
  surfaceSunken: t("neutral", 4),
  border: t("neutralVariant", 30),
  borderStrong: t("neutralVariant", 60),
  text: t("neutral", 92),
  textMuted: t("neutralVariant", 80),
  textOnAccent: t("brand", 20),
  accent: t("brand", 80),
  accentHover: t("brand", 85),
  accentPressed: t("brand", 75),
  accentSubtle: t("brand", 25),
  accentText: t("brand", 80),
  focusRing: t("brand", 80),
  overlay: t("neutral", 2),
  danger: t("danger", 80),
  onDanger: t("danger", 20),
  dangerSubtle: t("danger", 25),
  dangerText: t("danger", 90),
  warning: t("warning", 80),
  onWarning: t("warning", 20),
  warningSubtle: t("warning", 25),
  warningText: t("warning", 90),
  success: t("success", 80),
  onSuccess: t("success", 20),
  successSubtle: t("success", 25),
  successText: t("success", 90),
  info: t("info", 80),
  onInfo: t("info", 20),
  infoSubtle: t("info", 25),
  infoText: t("info", 90),
};

/** Starting tone of every generated color, per mode. */
export const TONES: Readonly<Record<Mode, Readonly<Record<ColorName, ToneSpec>>>> = {
  light: LIGHT,
  dark: DARK,
};

/** Scrim opacity for the overlay token. The overlay color itself is n2 (never pure black). */
export const OVERLAY_OPACITY: Readonly<Record<Mode, number>> = { light: 0.4, dark: 0.6 };

export type ModeColors = Readonly<Record<ColorName, string>> & {
  readonly overlayOpacity: number;
};

/** Build a complete record over COLOR_NAMES. */
export function mapNames<T>(fn: (name: ColorName) => T): Record<ColorName, T> {
  // Filled key by key from COLOR_NAMES, so every key is present when this returns.
  const out = {} as Record<ColorName, T>;
  for (const name of COLOR_NAMES) out[name] = fn(name);
  return out;
}
