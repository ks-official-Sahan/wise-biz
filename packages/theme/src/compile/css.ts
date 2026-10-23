import { COLOR_NAMES } from "../tokens.ts";
import { kebab } from "../util.ts";

import type { ResolvedTheme } from "../resolve.ts";
import type { Mode } from "../schema.ts";
import type { ColorName, ModeColors } from "../tokens.ts";

function colorDeclarations(colors: ModeColors): string[] {
  const names: readonly ColorName[] = COLOR_NAMES;
  const decls = names.map((name) => `--wb-color-${kebab(name)}:${colors[name]}`);
  decls.push(`--wb-color-overlay-opacity:${String(colors.overlayOpacity)}`);
  return decls.sort();
}

function sharedDeclarations(theme: ResolvedTheme): string[] {
  const { scales } = theme;
  const decls: string[] = scales.space.map(
    (value, index) => `--wb-space-${String(index)}:${String(value)}px`,
  );
  for (const [name, value] of Object.entries(scales.radius)) {
    decls.push(`--wb-radius-${name}:${String(value)}px`);
  }
  for (const [name, value] of Object.entries(scales.fontSize)) {
    decls.push(`--wb-font-size-${name}:${String(value)}px`);
  }
  for (const [name, value] of Object.entries(scales.motion)) {
    decls.push(
      typeof value === "number"
        ? `--wb-motion-${kebab(name)}:${String(value)}ms`
        : `--wb-motion-${kebab(name)}:cubic-bezier(${value.map(String).join(",")})`,
    );
  }
  return decls;
}

function rule(selector: string, mode: Mode, declarations: readonly string[]): string {
  return `${selector}{color-scheme:${mode};${declarations.join(";")}}`;
}

/**
 * CSS custom properties for the web (console, storefront, POS web). Deterministic: color declarations
 * are sorted, and the output depends only on the resolved theme.
 */
export function toCssVariables(theme: ResolvedTheme): string {
  const shared = sharedDeclarations(theme);
  const defaultMode = theme.modes.default;
  const defaultTokens = theme.tokens[defaultMode];
  if (defaultTokens === undefined) throw new Error(`Default mode ${defaultMode} has no tokens`);

  if (theme.modes.available.length === 1) {
    return rule(":root", defaultMode, [...shared, ...colorDeclarations(defaultTokens.color)]);
  }

  const otherMode: Mode = defaultMode === "light" ? "dark" : "light";
  const otherTokens = theme.tokens[otherMode];
  if (otherTokens === undefined) throw new Error(`Mode ${otherMode} has no tokens`);
  const otherDecls = colorDeclarations(otherTokens.color);

  return [
    rule(`:root,[data-theme="${defaultMode}"]`, defaultMode, [
      ...shared,
      ...colorDeclarations(defaultTokens.color),
    ]),
    rule(`[data-theme="${otherMode}"]`, otherMode, otherDecls),
    `@media (prefers-color-scheme: ${otherMode}){${rule(":root:not([data-theme])", otherMode, otherDecls)}}`,
  ].join("\n");
}
