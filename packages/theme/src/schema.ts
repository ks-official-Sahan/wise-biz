import { z } from "zod";

import { ColorInputSchema } from "./color.ts";

export const MODES = ["light", "dark"] as const;
export type Mode = (typeof MODES)[number];

export const BODY_FONTS = ["geist", "inter", "ibm-plex-sans", "noto-sans"] as const;
export type BodyFont = (typeof BODY_FONTS)[number];

export const NUMERIC_FONTS = ["geist-mono", "ibm-plex-mono", "jetbrains-mono"] as const;
export type NumericFont = (typeof NUMERIC_FONTS)[number];

export const DENSITIES = ["compact", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];

const ModesSchema = z
  .strictObject({
    available: z.union([
      z.tuple([z.literal("light")]),
      z.tuple([z.literal("dark")]),
      z.tuple([z.literal("light"), z.literal("dark")]),
    ]),
    default: z.enum(MODES),
  })
  .superRefine((modes, ctx) => {
    const available: readonly string[] = modes.available;
    if (!available.includes(modes.default)) {
      ctx.addIssue({
        code: "custom",
        message: "modes.default must be one of modes.available",
        path: ["default"],
      });
    }
  });

const FontSchema = z.strictObject({
  body: z.enum(BODY_FONTS),
  numeric: z.enum(NUMERIC_FONTS),
});

const ModeOverridesSchema = z.strictObject({
  seed: ColorInputSchema.optional(),
  accent: ColorInputSchema.optional(),
  canvas: ColorInputSchema.optional(),
  surface: ColorInputSchema.optional(),
});

const OverridesSchema = z.strictObject({
  light: ModeOverridesSchema.optional(),
  dark: ModeOverridesSchema.optional(),
});

const ThemeBodyShape = {
  modes: ModesSchema,
  brand: z.strictObject({ seed: ColorInputSchema }),
  font: FontSchema,
  density: z.enum(DENSITIES),
  overrides: OverridesSchema.optional(),
};

/** A whole-store theme. Status, text, sizes and targets are not part of the shape, so they cannot be set. */
export const ThemeInputSchema = z
  .strictObject({
    version: z.literal(1),
    name: z.string().min(1).max(60),
    ...ThemeBodyShape,
  })
  .superRefine((theme, ctx) => {
    const available: readonly string[] = theme.modes.available;
    for (const mode of MODES) {
      if (theme.overrides?.[mode] !== undefined && !available.includes(mode)) {
        ctx.addIssue({
          code: "custom",
          message: `overrides.${mode} requires ${mode} in modes.available`,
          path: ["overrides", mode],
        });
      }
    }
  });

/** Partial document for a branch layer. Validated again after it is merged onto its parent. */
export const BranchOverrideSchema = z.strictObject(ThemeBodyShape).partial();

export const TerminalPrefsSchema = z.strictObject({
  density: z.enum(DENSITIES).optional(),
  leftHanded: z.boolean().optional(),
});

export type ThemeInput = z.infer<typeof ThemeInputSchema>;
export type BranchOverride = z.infer<typeof BranchOverrideSchema>;
export type TerminalPrefs = z.infer<typeof TerminalPrefsSchema>;
export type ModeOverrides = z.infer<typeof ModeOverridesSchema>;
export type Overrides = z.infer<typeof OverridesSchema>;

export function parseThemeInput(value: unknown): ThemeInput {
  return ThemeInputSchema.parse(value);
}

export function safeParseThemeInput(value: unknown) {
  return ThemeInputSchema.safeParse(value);
}

export function parseTerminalPrefs(value: unknown): TerminalPrefs {
  return TerminalPrefsSchema.parse(value);
}
