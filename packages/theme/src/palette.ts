import { Hct, TonalPalette, argbFromHex, hexFromArgb } from "@material/material-color-utilities";

import { remember } from "./util.ts";

export const BRAND_MIN_CHROMA = 24;
const NEUTRAL_CHROMA = 6;
const NEUTRAL_VARIANT_CHROMA = 10;
const SEED_CACHE_LIMIT = 32;

/** Fixed, not brandable. Status meaning must hold across every store. */
export const STATUS_SEEDS = {
  danger: "#b3261e",
  warning: "#8a5300",
  success: "#1e6b3a",
  info: "#1f5fa8",
} as const;

export type StatusKind = keyof typeof STATUS_SEEDS;

export type PaletteKind = "brand" | "neutral" | "neutralVariant" | StatusKind;

export type ModePalettes = Readonly<Record<PaletteKind, TonalPalette>>;

/** Palette with the seed's HCT hue and at least `chromaFloor` chroma. */
function fromSeed(seedHex: string, chromaFloor: number): TonalPalette {
  const seed = Hct.fromInt(argbFromHex(seedHex));
  return TonalPalette.fromHueAndChroma(seed.hue, Math.max(seed.chroma, chromaFloor));
}

/** Brand palette: the seed's hue, chroma at least BRAND_MIN_CHROMA. */
export function brandPalette(seedHex: string): TonalPalette {
  return fromSeed(seedHex, BRAND_MIN_CHROMA);
}

/** Neutral palette: the seed's hue at low chroma (6). */
export function neutralPalette(seedHex: string): TonalPalette {
  return TonalPalette.fromHueAndChroma(Hct.fromInt(argbFromHex(seedHex)).hue, NEUTRAL_CHROMA);
}

/** Neutral variant palette: the seed's hue at chroma 10, for borders and muted text. */
export function neutralVariantPalette(seedHex: string): TonalPalette {
  return TonalPalette.fromHueAndChroma(
    Hct.fromInt(argbFromHex(seedHex)).hue,
    NEUTRAL_VARIANT_CHROMA,
  );
}

let statusCache: Readonly<Record<StatusKind, TonalPalette>> | undefined;

/** Palette for a fixed status seed. Not affected by any tenant seed. */
export function statusPalette(kind: StatusKind): TonalPalette {
  statusCache ??= {
    danger: fromSeed(STATUS_SEEDS.danger, BRAND_MIN_CHROMA),
    warning: fromSeed(STATUS_SEEDS.warning, BRAND_MIN_CHROMA),
    success: fromSeed(STATUS_SEEDS.success, BRAND_MIN_CHROMA),
    info: fromSeed(STATUS_SEEDS.info, BRAND_MIN_CHROMA),
  };
  return statusCache[kind];
}

const seedCache = new Map<string, ModePalettes>();

/** Every palette a mode needs, derived from one brand seed. Memoized per seed. */
export function palettesFor(seedHex: string): ModePalettes {
  const cached = seedCache.get(seedHex);
  if (cached !== undefined) return cached;
  const built: ModePalettes = Object.freeze({
    brand: brandPalette(seedHex),
    neutral: neutralPalette(seedHex),
    neutralVariant: neutralVariantPalette(seedHex),
    danger: statusPalette("danger"),
    warning: statusPalette("warning"),
    success: statusPalette("success"),
    info: statusPalette("info"),
  });
  remember(seedCache, seedHex, built, SEED_CACHE_LIMIT);
  return built;
}

/** Lowercase `#rrggbb` of an integer HCT tone (0 to 100) in a palette. */
export function tone(palette: TonalPalette, tone: number): string {
  if (!Number.isInteger(tone) || tone < 0 || tone > 100) {
    throw new RangeError(`Tone must be an integer from 0 to 100: ${String(tone)}`);
  }
  return hexFromArgb(palette.tone(tone)).toLowerCase();
}

/** HCT tone (perceptual lightness, L*) of a `#rrggbb` color. */
export function toneOf(hex: string): number {
  return Hct.fromInt(argbFromHex(hex)).tone;
}
