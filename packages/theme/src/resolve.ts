import { componentTokens } from "./component.ts";
import { scalesFor } from "./scales.ts";
import { BranchOverrideSchema, MODES, parseTerminalPrefs, parseThemeInput } from "./schema.ts";
import { buildModeColors, seedFor } from "./semantic.ts";
import { canonicalJson, deepFreeze, fnv1a, remember } from "./util.ts";

import type { ComponentTokens } from "./component.ts";
import type { Scales } from "./scales.ts";
import type {
  BodyFont,
  BranchOverride,
  Density,
  Mode,
  ModeOverrides,
  NumericFont,
  Overrides,
  TerminalPrefs,
  ThemeInput,
} from "./schema.ts";
import type { ModeColors } from "./tokens.ts";

export interface ModeTokens {
  readonly color: ModeColors;
  readonly component: ComponentTokens;
}

export interface ResolvedTheme {
  readonly id: string;
  readonly name: string;
  readonly modes: { readonly available: readonly Mode[]; readonly default: Mode };
  readonly font: { readonly body: BodyFont; readonly numeric: NumericFont };
  readonly density: Density;
  readonly leftHanded: boolean;
  readonly scales: Scales;
  /** Effective brand seed per available mode (after the mode's seed override). */
  readonly seeds: { readonly light?: string; readonly dark?: string };
  readonly tokens: { readonly light?: ModeTokens; readonly dark?: ModeTokens };
}

export interface ResolveRequest {
  readonly platform: ThemeInput;
  readonly tenant?: ThemeInput;
  readonly branch?: BranchOverride;
  readonly terminal?: TerminalPrefs;
}

const MEMO_LIMIT = 32;
// Keyed by the full canonical input, never by the short id: a 32-bit hash can be forged to collide, and a tenant must
// never receive another tenant's cached theme.
const memo = new Map<string, ResolvedTheme>();

/** Drop per-mode seed overrides. A layer that sets `brand` supersedes them. */
function withoutSeeds(overrides: Overrides | undefined): Overrides | undefined {
  if (overrides === undefined) return undefined;
  const out: Overrides = {};
  for (const mode of MODES) {
    const modeOverrides = overrides[mode];
    if (modeOverrides === undefined) continue;
    const copy: ModeOverrides = { ...modeOverrides };
    delete copy.seed;
    out[mode] = copy;
  }
  return out;
}

/** Keep overrides only for modes the merged theme makes available. */
function forAvailable(
  overrides: Overrides | undefined,
  available: readonly string[],
): Overrides | undefined {
  if (overrides === undefined) return undefined;
  const out: Overrides = {};
  for (const mode of MODES) {
    const modeOverrides = overrides[mode];
    if (modeOverrides !== undefined && available.includes(mode)) out[mode] = modeOverrides;
  }
  return out;
}

type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** Copy of `value` without keys whose value is undefined (zod partial output carries them). */
function definedEntries<T extends object>(value: T): Defined<T> {
  const out: Defined<T> = {};
  for (const key of Object.keys(value) as (keyof T)[]) {
    const item: T[keyof T] | undefined = value[key];
    if (item !== undefined) Object.assign(out, { [key]: item });
  }
  return out;
}

/** Top-level keys of `patch` replace the base; per-mode overrides follow the rules above. */
function applyLayer(base: ThemeInput, patch: Partial<ThemeInput>): ThemeInput {
  const next: ThemeInput = { ...base, ...patch };
  const inherited =
    patch.overrides ?? (patch.brand === undefined ? base.overrides : withoutSeeds(base.overrides));
  delete next.overrides;
  const overrides = forAvailable(inherited, next.modes.available);
  if (overrides !== undefined) next.overrides = overrides;
  return next;
}

function build(input: ThemeInput, id: string, leftHanded: boolean): ResolvedTheme {
  const scales = scalesFor(input.density);
  const available: readonly Mode[] = input.modes.available;
  const seeds: { light?: string; dark?: string } = {};
  const tokens: { light?: ModeTokens; dark?: ModeTokens } = {};
  for (const mode of available) {
    seeds[mode] = seedFor(input, mode);
    const color = buildModeColors(input, mode);
    tokens[mode] = { color, component: componentTokens(color, scales) };
  }
  return deepFreeze({
    id,
    name: input.name,
    modes: { available, default: input.modes.default },
    font: input.font,
    density: input.density,
    leftHanded,
    scales,
    seeds,
    tokens,
  });
}

/**
 * Merge platform, tenant, branch and terminal layers into one frozen theme. Terminal prefs may set
 * only density and leftHanded. Same input gives the same id and the same deep-equal output.
 */
export function resolveTheme(request: ResolveRequest): ResolvedTheme {
  const terminal = parseTerminalPrefs(request.terminal ?? {});
  // Every layer is validated on its own first, so input the schema rejects never resolves silently.
  let merged = parseThemeInput(request.platform);
  if (request.tenant !== undefined) merged = applyLayer(merged, parseThemeInput(request.tenant));
  if (request.branch !== undefined) {
    merged = applyLayer(merged, definedEntries(BranchOverrideSchema.parse(request.branch)));
  }
  const input = parseThemeInput({ ...merged, density: terminal.density ?? merged.density });
  const leftHanded = terminal.leftHanded ?? false;
  const key = canonicalJson({ input, leftHanded });
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  // Short display/version id only; not unique by contract (see memo note).
  const theme = build(input, fnv1a(key), leftHanded);
  remember(memo, key, theme, MEMO_LIMIT);
  return theme;
}
