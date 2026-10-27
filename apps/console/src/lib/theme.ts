import { PLATFORM_THEME, resolveTheme, toCssVariables } from "@wise-biz/theme";

let cached: string | undefined;

/**
 * Platform theme as CSS custom properties, generated on the server once per process. Material Color Utilities stays
 * out of the client bundle; tenant themes arrive with the theming module (P1-13c) through the same function.
 */
export function platformThemeCss(): string {
  cached ??= toCssVariables(resolveTheme({ platform: PLATFORM_THEME }));
  return cached;
}
