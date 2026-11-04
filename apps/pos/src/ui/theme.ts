import { PLATFORM_THEME, resolveTheme } from "@wise-biz/theme";

import type { ResolvedTheme } from "@wise-biz/theme";

let platform: ResolvedTheme | undefined;

/**
 * The theme for this terminal. Tenant and branch themes arrive through the synced theme dataset (P1-14); until a
 * terminal has one, the platform theme applies. Resolution is pure, so the result is cached.
 */
export function themeFor(): ResolvedTheme {
  platform ??= resolveTheme({ platform: PLATFORM_THEME });
  return platform;
}
