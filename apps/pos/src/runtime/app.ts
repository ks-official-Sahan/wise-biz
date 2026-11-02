import Constants from "expo-constants";
import { Platform as RnPlatform } from "react-native";

import { createPosStore, loadPersisted } from "../state/store.ts";

import { createController } from "./controller.ts";
import { createDesktopVault, getDesktop, openDesktopSqlite } from "./desktop.ts";
import { reportError, setReportSink } from "./report.ts";
import { openExpoSqlite } from "./sqlite-adapter.ts";
import { createKeyValue, createVault, isLowTrustPlatform } from "./vault.ts";

import type { Platform } from "../platform/index.ts";

export interface App {
  readonly store: ReturnType<typeof createPosStore>;
  readonly controller: ReturnType<typeof createController>;
}

const configuredUrl = process.env.EXPO_PUBLIC_API_URL as string | undefined;
if (configuredUrl === undefined && process.env.NODE_ENV === "production") {
  throw new Error(
    "EXPO_PUBLIC_API_URL is not set: refusing to sign requests for an unknown server",
  );
}
const API_URL = configuredUrl ?? "http://localhost:3000";

const platformName = (): Platform => {
  const desktop = getDesktop();
  if (desktop !== undefined) return desktop.platform;
  switch (RnPlatform.OS) {
    case "android":
    case "ios":
      return RnPlatform.OS;
    default:
      return "web";
  }
};

setReportSink((line) => {
  if (process.env.NODE_ENV !== "production") console.warn(line);
});

let cached: Promise<App> | undefined;

/** Builds the store and controller once per process. Persisted UI preferences are loaded first so the first paint is right. */
export function getApp(): Promise<App> {
  cached ??= (async () => {
    const storage = createKeyValue();
    const { ui } = await loadPersisted(storage);
    const store = createPosStore({ storage, ui });
    // Inside the Electron shell the database and the device key live in the main process (better-sqlite3, safeStorage).
    const desktop = getDesktop();
    const controller = createController({
      store,
      vault: desktop === undefined ? createVault() : createDesktopVault(desktop),
      openStorage: desktop === undefined ? openExpoSqlite : (id) => openDesktopSqlite(desktop, id),
      fetch: (input, init) => fetch(input, init),
      baseUrl: API_URL,
      platform: platformName(),
      appVersion: Constants.expoConfig?.version ?? "0.0.0",
      lowTrust: desktop === undefined && isLowTrustPlatform,
      onError: reportError,
      // Web has a streaming fetch; React Native polls (the hint stream is an optimisation).
      ...(RnPlatform.OS === "web" ? { streamingFetch: fetch.bind(globalThis) } : {}),
    });
    return { store, controller };
  })();
  return cached;
}
