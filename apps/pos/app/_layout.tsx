import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, ToastProvider, Text } from "@wise-biz/ui";
import { Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Provider } from "react-redux";

import { getApp } from "../src/runtime/app.ts";
import { reportError } from "../src/runtime/report.ts";
import { uiSlice } from "../src/state/slices.ts";
import { ErrorBoundary } from "../src/ui/chrome.tsx";
import { ControllerProvider } from "../src/ui/context.tsx";
import { useAppDispatch, useAppSelector } from "../src/ui/hooks.ts";
import { themeFor } from "../src/ui/theme.ts";

import type { App } from "../src/runtime/app.ts";
import type { ReactNode } from "react";

function Themed({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  const mode = useAppSelector((s) => s.ui.modePreference);
  return (
    <ThemeProvider
      theme={themeFor()}
      mode={mode}
      onModeChange={(m) => dispatch(uiSlice.actions.setModePreference(m))}
    >
      <ToastProvider>{children}</ToastProvider>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const [app, setApp] = useState<App>();
  const [failed, setFailed] = useState(false);
  const queries = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } }),
    [],
  );

  useEffect(() => {
    let alive = true;
    getApp()
      .then(async (a) => {
        await a.controller.boot();
        if (alive) setApp(a);
      })
      .catch((e: unknown) => {
        reportError(e);
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed) return <Text>This device could not open its local database. Restart the app.</Text>;
  if (app === undefined) return null;
  return (
    <Provider store={app.store}>
      <ControllerProvider controller={app.controller}>
        <QueryClientProvider client={queries}>
          <Themed>
            <ErrorBoundary onError={reportError}>
              <Stack screenOptions={{ headerShown: false, animation: "fade" }} />
            </ErrorBoundary>
          </Themed>
        </QueryClientProvider>
      </ControllerProvider>
    </Provider>
  );
}
