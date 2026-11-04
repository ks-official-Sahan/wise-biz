import { deepFreeze } from "./util.ts";

import type { BodyFont, Density, NumericFont } from "./schema.ts";

const BASE = {
  space: [0, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64],
  radius: { control: 8, card: 12, pill: 999 },
  fontSize: { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, "2xl": 32, "3xl": 40, "4xl": 48 },
  total: { sm: 32, lg: 48 },
  lineHeight: { heading: 1.25, body: 1.5 },
  weight: { regular: 400, medium: 500 },
  target: { min: 48, minPointer: 24, gap: 8 },
  motion: {
    press: 140,
    enter: 220,
    exit: 160,
    easeOut: [0.23, 1, 0.32, 1],
    easeSheet: [0.32, 0.72, 0, 1],
  },
} as const;

interface ControlMetrics {
  readonly control: number;
  readonly key: number;
}

const CONTROLS: Readonly<Record<Density, ControlMetrics>> = {
  compact: { control: 44, key: 48 },
  comfortable: { control: 52, key: 56 },
};

export type Scales = typeof BASE & {
  readonly control: ControlMetrics;
  readonly cartTotal: number;
};

const makeScales = (density: Density): Scales =>
  deepFreeze({
    ...BASE,
    control: CONTROLS[density],
    cartTotal: density === "compact" ? BASE.total.sm : BASE.total.lg,
  });

const SCALES: Readonly<Record<Density, Scales>> = {
  compact: makeScales("compact"),
  comfortable: makeScales("comfortable"),
};

/** Non-color tokens for a density. Keys and controls are never below `target.min`. */
export function scalesFor(density: Density): Scales {
  return SCALES[density];
}

export const BODY_FONT_FAMILY: Readonly<Record<BodyFont, string>> = {
  geist: "Geist",
  inter: "Inter",
  "ibm-plex-sans": "IBM Plex Sans",
  "noto-sans": "Noto Sans",
};

export const NUMERIC_FONT_FAMILY: Readonly<Record<NumericFont, string>> = {
  "geist-mono": "Geist Mono",
  "ibm-plex-mono": "IBM Plex Mono",
  "jetbrains-mono": "JetBrains Mono",
};
