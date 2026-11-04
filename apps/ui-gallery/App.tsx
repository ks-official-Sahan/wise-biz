import { toNativeTheme } from "@wise-biz/theme";
import { ThemeProvider, ToastProvider, createStyles, useTheme } from "@wise-biz/ui";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, View } from "react-native";

import { GalleryHeader } from "./src/components/GalleryHeader.tsx";
import { useGalleryFonts } from "./src/lib/fonts.ts";
import { themeFor } from "./src/lib/themes.ts";
import { DEFAULT_STATE, parseState, serializeState } from "./src/lib/urlState.ts";
import { ComponentsView } from "./src/screens/ComponentsView.tsx";
import { SellView } from "./src/screens/SellView.tsx";

import type { GalleryState, ModeParam, ThemeId, ViewKey } from "./src/lib/urlState.ts";
import type { ModePreference } from "@wise-biz/ui";

declare global {
  interface Window {
    /** Last theme switch, control press to next commit. Read by the e2e suite. */
    __wbThemeSwitchMs?: number;
  }
}

const useRootStyles = createStyles((t) => ({
  root: { flex: 1, backgroundColor: t.color.canvas, minHeight: "100%" as const },
  body: { flex: 1, minHeight: 0 },
}));

function readInitialState(): GalleryState {
  if (Platform.OS !== "web" || typeof window === "undefined") return DEFAULT_STATE;
  return parseState(window.location.search);
}

/** Splash until the fonts are ready: canvas color only, no text, so nothing flashes in a fallback face. */
export function App() {
  const ready = useGalleryFonts();
  if (!ready) return <SplashView />;
  return <GalleryApp />;
}

function SplashView() {
  const theme = themeFor("platform");
  const canvas = toNativeTheme(theme, theme.modes.default).color.canvas;
  return <View style={{ flex: 1, backgroundColor: canvas }} />;
}

function GalleryApp() {
  const [state, setState] = useState<GalleryState>(readInitialState);
  const [switchMs, setSwitchMs] = useState<number | null>(null);
  // Set on a control press that changes the theme or mode; cleared by the next commit.
  const switchStart = useRef<number | null>(null);
  const theme = useMemo(() => themeFor(state.theme), [state.theme]);

  // Runs after every App commit, which includes the commit that applies a theme or mode change.
  // React.Profiler onRender is not called in production builds, so the commit is timed here instead.
  useLayoutEffect(() => {
    const started = switchStart.current;
    if (started === null) return;
    switchStart.current = null;
    const ms = Math.round(performance.now() - started);
    window.__wbThemeSwitchMs = ms;
    setSwitchMs(ms);
  }, [state]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const next = `${window.location.pathname}${serializeState(state)}`;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(null, "", next);
    }
  }, [state]);

  const update = useCallback((patch: Partial<GalleryState>) => {
    switchStart.current = performance.now();
    setState((previous) => ({ ...previous, ...patch }));
  }, []);

  const handleThemeChange = useCallback(
    (id: ThemeId) => {
      if (id !== state.theme) update({ theme: id });
    },
    [state.theme, update],
  );

  const handleViewChange = useCallback(
    (view: ViewKey) => {
      if (view !== state.view) setState((previous) => ({ ...previous, view }));
    },
    [state.view],
  );

  const handleModeChange = useCallback(
    (mode: ModePreference) => {
      const next: ModeParam = mode;
      if (next !== state.mode) update({ mode: next });
    },
    [state.mode, update],
  );

  return (
    <ThemeProvider theme={theme} mode={state.mode} onModeChange={handleModeChange}>
      <ToastProvider>
        <Shell
          themeId={state.theme}
          view={state.view}
          switchMs={switchMs}
          onThemeChange={handleThemeChange}
          onViewChange={handleViewChange}
        />
      </ToastProvider>
    </ThemeProvider>
  );
}

interface ShellProps {
  readonly themeId: ThemeId;
  readonly view: ViewKey;
  readonly switchMs: number | null;
  readonly onThemeChange: (id: ThemeId) => void;
  readonly onViewChange: (view: ViewKey) => void;
}

/** Inside the providers so it can read tokens and the mode. */
function Shell({ themeId, view, switchMs, onThemeChange, onViewChange }: ShellProps) {
  const styles = useRootStyles();
  const { color, mode } = useTheme();

  useEffect(() => {
    if (Platform.OS !== "web") return;
    document.body.style.backgroundColor = color.canvas;
  }, [color.canvas]);

  return (
    <View style={styles.root}>
      <StatusBar style={mode === "dark" ? "light" : "dark"} />
      <GalleryHeader
        themeId={themeId}
        view={view}
        switchMs={switchMs}
        onThemeChange={onThemeChange}
        onViewChange={onViewChange}
      />
      <View role="main" style={styles.body}>
        {view === "sell" ? <SellView /> : <ComponentsView />}
      </View>
    </View>
  );
}
