import { deepFreeze } from "./util.ts";

import type { ThemeInput } from "./schema.ts";

/** Platform default: both modes, teal "Counter" light and amber "Workshop" dark. */
export const PLATFORM_THEME: ThemeInput = deepFreeze({
  version: 1,
  name: "wise-biz",
  modes: { available: ["light", "dark"], default: "light" },
  brand: { seed: "#0E7C66" },
  font: { body: "geist", numeric: "geist-mono" },
  density: "comfortable",
  overrides: { dark: { seed: "#C98A12" } },
});

/**
 * Demo data for previews and tests only. These are sample store names, not real merchants.
 * Each one shows a different mode set and seed.
 */
export const SAMPLE_THEMES: readonly ThemeInput[] = deepFreeze([
  {
    version: 1,
    name: "Kade Cafe",
    modes: { available: ["light", "dark"], default: "light" },
    brand: { seed: "#C2410C" },
    font: { body: "inter", numeric: "ibm-plex-mono" },
    density: "comfortable",
  },
  {
    version: 1,
    name: "Lanka Hardware",
    modes: { available: ["dark"], default: "dark" },
    brand: { seed: "#CA8A04" },
    font: { body: "noto-sans", numeric: "jetbrains-mono" },
    density: "compact",
  },
  {
    version: 1,
    name: "Nila Pharmacy",
    modes: { available: ["light"], default: "light" },
    brand: { seed: "#1D4ED8" },
    font: { body: "ibm-plex-sans", numeric: "geist-mono" },
    density: "compact",
  },
]);
