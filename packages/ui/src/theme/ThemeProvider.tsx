import { toNativeTheme } from "@wise-biz/theme";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useColorScheme } from "react-native";

import type { Mode, NativeTheme, ResolvedTheme } from "@wise-biz/theme";
import type { ReactNode } from "react";

/** What the user asked for. "system" follows the device setting. */
export type ModePreference = Mode | "system";

export interface ModeState {
  /** Mode in effect right now. */
  readonly mode: Mode;
  readonly preference: ModePreference;
  readonly available: readonly Mode[];
  /** True only when the store offers both light and dark. */
  readonly canToggle: boolean;
  readonly setPreference: (preference: ModePreference) => void;
}

export interface ThemeProviderProps {
  readonly theme: ResolvedTheme;
  /** Controlled preference. Omit it to let the provider keep its own preference (default "system"). */
  readonly mode?: ModePreference | undefined;
  readonly onModeChange?: ((mode: ModePreference) => void) | undefined;
  readonly children?: ReactNode;
}

const ThemeContext = createContext<NativeTheme | null>(null);
const ThemeModeContext = createContext<ModeState | null>(null);

/**
 * Mode in effect. A store with one mode always shows it. Otherwise the preference wins, and "system"
 * follows the device scheme, falling back to the store default when the device reports none.
 */
export function resolveEffectiveMode(
  theme: ResolvedTheme,
  preference: ModePreference,
  systemScheme: "light" | "dark" | null | undefined,
): Mode {
  const { available } = theme.modes;
  if (available.length === 1) return available[0] ?? theme.modes.default;
  if (preference !== "system") return preference;
  if (systemScheme === "light" || systemScheme === "dark") return systemScheme;
  return theme.modes.default;
}

export function ThemeProvider({
  theme,
  mode,
  onModeChange,
  children,
}: ThemeProviderProps): ReactNode {
  const [ownPreference, setOwnPreference] = useState<ModePreference>("system");
  const preference = mode ?? ownPreference;
  const systemScheme = useColorScheme();
  const { available } = theme.modes;
  const canToggle = available.length > 1;
  const effective = resolveEffectiveMode(theme, preference, systemScheme);
  const native = useMemo(() => toNativeTheme(theme, effective), [theme, effective]);

  // Read the latest callback without re-creating setPreference (and the mode context) on every render.
  const onChangeRef = useRef(onModeChange);
  useEffect(() => {
    onChangeRef.current = onModeChange;
  }, [onModeChange]);

  const setPreference = useCallback(
    (next: ModePreference) => {
      if (!canToggle) return;
      if (mode === undefined) setOwnPreference(next);
      onChangeRef.current?.(next);
    },
    [canToggle, mode],
  );

  const modeState = useMemo<ModeState>(
    () => ({ mode: effective, preference, available, canToggle, setPreference }),
    [effective, preference, available, canToggle, setPreference],
  );

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.dataset.theme = effective;
  }, [effective]);

  return (
    <ThemeContext.Provider value={native}>
      <ThemeModeContext.Provider value={modeState}>{children}</ThemeModeContext.Provider>
    </ThemeContext.Provider>
  );
}

/** Native theme for the effective mode. Throws outside ThemeProvider. */
export function useTheme(): NativeTheme {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error("useTheme must be used inside <ThemeProvider>.");
  return value;
}

/** Mode state for toggles. Changes here do not re-render components that only read useTheme(). */
export function useThemeMode(): ModeState {
  const value = useContext(ThemeModeContext);
  if (value === null) throw new Error("useThemeMode must be used inside <ThemeProvider>.");
  return value;
}
