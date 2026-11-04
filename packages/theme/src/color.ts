import { z } from "zod";

export const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

export class ColorError extends Error {
  override readonly name = "ColorError";
}

const UnitSchema = z.number().min(0).max(1);

/** DTCG 2025.10 color object, sRGB, components in 0..1. A stated hex must agree with the components. */
export const DtcgColorSchema = z
  .strictObject({
    colorSpace: z.literal("srgb"),
    components: z.tuple([UnitSchema, UnitSchema, UnitSchema]),
    hex: z.string().regex(HEX_PATTERN, "Expected a #rrggbb color").optional(),
    // Opaque only: token colors are #rrggbb. Translucency is a separate token (overlayOpacity).
    alpha: z.literal(1).optional(),
  })
  .superRefine((color, ctx) => {
    if (color.hex !== undefined && color.hex.toLowerCase() !== componentsToHex(color.components)) {
      ctx.addIssue({ code: "custom", message: "hex does not match components", path: ["hex"] });
    }
  });

/** A `#rrggbb` string or a DTCG color object. */
export const ColorInputSchema = z.union([
  z.string().regex(HEX_PATTERN, "Expected a #rrggbb color"),
  DtcgColorSchema,
]);

export type DtcgColor = z.infer<typeof DtcgColorSchema>;
export type ColorInput = z.infer<typeof ColorInputSchema>;

/** Channel values 0..255 of a `#rrggbb` string (case-insensitive). */
export function parseHex(hex: string): readonly [number, number, number] {
  if (!HEX_PATTERN.test(hex)) throw new ColorError(`Invalid hex color: ${hex}`);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

const channelHex = (component: number): string =>
  Math.round(component * 255)
    .toString(16)
    .padStart(2, "0");

export function componentsToHex(components: readonly [number, number, number]): string {
  return `#${components.map(channelHex).join("")}`;
}

/** Lowercase `#rrggbb` for an opaque color. Throws for malformed hex or non-opaque alpha. */
export function normalizeHex(color: ColorInput): string {
  if (typeof color === "string") {
    if (!HEX_PATTERN.test(color)) throw new ColorError(`Invalid hex color: ${color}`);
    return color.toLowerCase();
  }
  return color.hex?.toLowerCase() ?? componentsToHex(color.components);
}

/** DTCG color object for a `#rrggbb` string. */
export function toDtcgColor(hex: string): DtcgColor {
  const [r, g, b] = parseHex(hex);
  return {
    colorSpace: "srgb",
    components: [r / 255, g / 255, b / 255],
    hex: hex.toLowerCase(),
  };
}
