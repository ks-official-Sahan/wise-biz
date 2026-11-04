import { render } from "@testing-library/react";
import { PLATFORM_THEME, resolveTheme } from "@wise-biz/theme";

import { ThemeProvider } from "../src/theme/ThemeProvider.tsx";

import type { ModePreference } from "../src/theme/ThemeProvider.tsx";
import type { ResolvedTheme } from "@wise-biz/theme";
import type { ReactElement, ReactNode } from "react";

/** Platform default theme: both modes, teal light and amber dark. */
export const TEST_THEME: ResolvedTheme = resolveTheme({ platform: PLATFORM_THEME });

export interface RenderOptions {
  readonly theme?: ResolvedTheme;
  readonly mode?: ModePreference;
  readonly onModeChange?: (mode: ModePreference) => void;
}

/** Render inside ThemeProvider. Components under test read tokens from it. */
export function renderWithTheme(ui: ReactElement, options: RenderOptions = {}) {
  const { theme = TEST_THEME, mode, onModeChange } = options;
  function Wrapper({ children }: { readonly children: ReactNode }) {
    return (
      <ThemeProvider theme={theme} mode={mode} onModeChange={onModeChange}>
        {children}
      </ThemeProvider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}
