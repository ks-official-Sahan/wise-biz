/**
 * Gallery state carried in the URL so Playwright can deep-link. Pure: no DOM access here.
 * Unknown or missing values fall back to the defaults, so a hand-edited URL never throws.
 */

export const THEME_OPTIONS = [
  { id: "platform", label: "Platform" },
  { id: "kade-cafe", label: "Kade Cafe" },
  { id: "lanka-hardware", label: "Lanka Hardware" },
  { id: "nila-pharmacy", label: "Nila Pharmacy" },
] as const;

export type ThemeId = (typeof THEME_OPTIONS)[number]["id"];
export type ModeParam = "light" | "dark" | "system";
export type ViewKey = "components" | "sell";

export interface GalleryState {
  readonly theme: ThemeId;
  readonly mode: ModeParam;
  readonly view: ViewKey;
}

export const DEFAULT_STATE: GalleryState = {
  theme: "platform",
  mode: "system",
  view: "components",
};

const MODES: readonly ModeParam[] = ["light", "dark", "system"];
const VIEWS: readonly ViewKey[] = ["components", "sell"];

function pick<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

export function parseState(search: string): GalleryState {
  const params = new URLSearchParams(search);
  const themeIds = THEME_OPTIONS.map((option) => option.id);
  return {
    theme: pick(params.get("theme"), themeIds, DEFAULT_STATE.theme),
    mode: pick(params.get("mode"), MODES, DEFAULT_STATE.mode),
    view: pick(params.get("view"), VIEWS, DEFAULT_STATE.view),
  };
}

/** Query string for a state, leading "?". All three keys are always written so links are self-describing. */
export function serializeState(state: GalleryState): string {
  const params = new URLSearchParams({ theme: state.theme, mode: state.mode, view: state.view });
  return `?${params.toString()}`;
}
