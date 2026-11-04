import { combineReducers, configureStore } from "@reduxjs/toolkit";

import { cartSlice, sessionSlice, uiInitial, uiSlice } from "./slices.ts";

import type { DeviceSummary, ModePreference, SessionState, UiState } from "./slices.ts";

const reducer = combineReducers({
  session: sessionSlice.reducer,
  ui: uiSlice.reducer,
  cart: cartSlice.reducer,
});

export type RootState = ReturnType<typeof reducer>;

/** Key-value storage for UI preferences and the device summary (AsyncStorage / localStorage; never secrets). */
export interface KeyValue {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

const KEY = "wb.pos.state.v1";

interface Persisted {
  ui: UiState;
  device: DeviceSummary | null;
}

const isModePreference = (v: unknown): v is ModePreference =>
  v === "system" || v === "light" || v === "dark";

/** Reads what was saved, tolerating a missing, old or corrupted value (it falls back to defaults). */
export async function loadPersisted(storage: KeyValue): Promise<Persisted> {
  try {
    const raw = await storage.getItem(KEY);
    if (raw === null) return { ui: uiInitial, device: null };
    const p = JSON.parse(raw) as { ui?: Partial<UiState>; device?: DeviceSummary | null };
    return {
      ui: {
        leftHanded: p.ui?.leftHanded === true,
        modePreference: isModePreference(p.ui?.modePreference) ? p.ui.modePreference : "system",
        themeId: typeof p.ui?.themeId === "string" ? p.ui.themeId : "platform",
      },
      device: p.device ?? null,
    };
  } catch {
    return { ui: uiInitial, device: null };
  }
}

/** The store, persisting UI preferences and the device summary (debounced). Cart and operator are never saved. */
export function createPosStore(opts: { storage: KeyValue; ui?: UiState; debounceMs?: number }) {
  const store = configureStore({
    reducer,
    ...(opts.ui ? { preloadedState: { ui: opts.ui } } : {}),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = "";
  store.subscribe(() => {
    const s = store.getState();
    const snapshot = JSON.stringify({ ui: s.ui, device: s.session.device } satisfies Persisted);
    if (snapshot === last) return;
    last = snapshot;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      opts.storage.setItem(KEY, snapshot).catch(() => undefined);
    }, opts.debounceMs ?? 250);
  });
  return store;
}

export type PosStore = ReturnType<typeof createPosStore>;
export type PosDispatch = PosStore["dispatch"];
export type { SessionState };
