import { toDtcgColor } from "../color.ts";
import { BODY_FONT_FAMILY, NUMERIC_FONT_FAMILY } from "../scales.ts";
import { COLOR_NAMES } from "../tokens.ts";
import { kebab } from "../util.ts";

import type { ResolvedTheme } from "../resolve.ts";
import type { Mode } from "../schema.ts";
import type { ColorName, ModeColors } from "../tokens.ts";

export interface DtcgToken {
  readonly $type: string;
  readonly $value: unknown;
}
export interface DtcgGroup {
  readonly [key: string]: DtcgGroup | DtcgToken;
}

export interface DtcgDocument {
  readonly tokens: {
    readonly base: DtcgGroup;
    readonly light?: DtcgGroup;
    readonly dark?: DtcgGroup;
  };
  readonly resolver: {
    readonly version: "2025.10";
    readonly sets: { readonly base: { readonly sources: readonly DtcgGroup[] } };
    readonly modifiers: {
      readonly theme: {
        readonly contexts: Readonly<Partial<Record<Mode, readonly DtcgGroup[]>>>;
        readonly default: Mode;
      };
    };
    readonly resolutionOrder: readonly { readonly $ref: string }[];
  };
}

const dimension = (value: number): DtcgToken => ({
  $type: "dimension",
  $value: { value, unit: "px" },
});

const duration = (value: number): DtcgToken => ({
  $type: "duration",
  $value: { value, unit: "ms" },
});

function mapValues(
  record: Readonly<Record<string, number>>,
  make: (value: number) => DtcgToken,
): DtcgGroup {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, make(value)] as const),
  );
}

/** Mode-independent tokens: spacing, radius, type, motion, targets, control heights. */
function baseGroup(theme: ResolvedTheme): DtcgGroup {
  const { scales } = theme;
  return {
    space: Object.fromEntries(
      scales.space.map((value, index) => [String(index), dimension(value)] as const),
    ),
    radius: mapValues(scales.radius, dimension),
    "font-size": mapValues(scales.fontSize, dimension),
    "line-height": mapValues(scales.lineHeight, (value) => ({ $type: "number", $value: value })),
    "font-weight": mapValues(scales.weight, (value) => ({ $type: "fontWeight", $value: value })),
    "font-family": {
      body: { $type: "fontFamily", $value: BODY_FONT_FAMILY[theme.font.body] },
      numeric: { $type: "fontFamily", $value: NUMERIC_FONT_FAMILY[theme.font.numeric] },
    },
    motion: {
      press: duration(scales.motion.press),
      enter: duration(scales.motion.enter),
      exit: duration(scales.motion.exit),
      "ease-out": { $type: "cubicBezier", $value: scales.motion.easeOut },
      "ease-sheet": { $type: "cubicBezier", $value: scales.motion.easeSheet },
    },
    target: {
      min: dimension(scales.target.min),
      "min-pointer": dimension(scales.target.minPointer),
      gap: dimension(scales.target.gap),
    },
    control: {
      control: dimension(scales.control.control),
      key: dimension(scales.control.key),
    },
  };
}

/** Color tokens of one mode as DTCG color objects with sRGB components and hex. */
function colorGroup(colors: ModeColors): DtcgGroup {
  const names: readonly ColorName[] = COLOR_NAMES;
  const group: Record<string, DtcgToken> = {};
  for (const name of names) {
    group[kebab(name)] = { $type: "color", $value: toDtcgColor(colors[name]) };
  }
  group["overlay-opacity"] = { $type: "number", $value: colors.overlayOpacity };
  return { color: group };
}

/**
 * DTCG 2025.10 document: a base set plus a `theme` modifier with one context per available mode.
 * Tokens are inlined in the resolver, so the document needs no external files.
 */
export function toDtcg(theme: ResolvedTheme): DtcgDocument {
  const base = baseGroup(theme);
  const contexts: Partial<Record<Mode, readonly DtcgGroup[]>> = {};
  const tokens: { base: DtcgGroup; light?: DtcgGroup; dark?: DtcgGroup } = { base };
  for (const mode of theme.modes.available) {
    const tokenSet = theme.tokens[mode];
    if (tokenSet === undefined) continue;
    const group = colorGroup(tokenSet.color);
    tokens[mode] = group;
    contexts[mode] = [group];
  }
  return {
    tokens,
    resolver: {
      version: "2025.10",
      sets: { base: { sources: [base] } },
      modifiers: { theme: { contexts, default: theme.modes.default } },
      resolutionOrder: [{ $ref: "#/sets/base" }, { $ref: "#/modifiers/theme" }],
    },
  };
}
