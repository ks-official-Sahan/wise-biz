import { createEntityAdapter, createSlice } from "@reduxjs/toolkit";

import type { PayloadAction } from "@reduxjs/toolkit";

// --- session -------------------------------------------------------------------------------------------------------

export type Phase = "booting" | "unenrolled" | "enrolled" | "locked" | "unlocked" | "blocked";
export type BlockedReason = "revoked" | "suspended" | "quarantined" | "diverged";

export interface DeviceSummary {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly name: string;
}

export interface OperatorSummary {
  readonly userId: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

export interface SessionState {
  phase: Phase;
  device: DeviceSummary | null;
  operator: OperatorSummary | null;
  blocked: BlockedReason | null;
  /** Web terminals keep the key in the browser: shown as a low-trust terminal in the console. */
  lowTrust: boolean;
}

const sessionInitial: SessionState = {
  phase: "booting",
  device: null,
  operator: null,
  blocked: null,
  lowTrust: false,
};

/**
 * Where the terminal is in its life: unknown -> enrolled -> locked (needs a PIN) -> unlocked, or blocked by the
 * server. The operator session is never persisted: a restart always asks for the PIN again.
 */
export const sessionSlice = createSlice({
  name: "session",
  initialState: sessionInitial,
  reducers: {
    booted(state, a: PayloadAction<{ device: DeviceSummary | null; lowTrust: boolean }>) {
      state.device = a.payload.device;
      state.lowTrust = a.payload.lowTrust;
      state.phase = a.payload.device === null ? "unenrolled" : "locked";
    },
    enrolled(state, a: PayloadAction<DeviceSummary>) {
      state.device = a.payload;
      state.phase = "enrolled";
    },
    /** First sync finished: the terminal is ready for a PIN. */
    ready(state) {
      if (state.phase === "enrolled") state.phase = "locked";
    },
    unlocked(state, a: PayloadAction<OperatorSummary>) {
      state.operator = a.payload;
      state.phase = "unlocked";
    },
    locked(state) {
      state.operator = null;
      if (state.phase === "unlocked") state.phase = "locked";
    },
    blocked(state, a: PayloadAction<BlockedReason>) {
      state.blocked = a.payload;
      state.operator = null;
      state.phase = "blocked";
    },
    /** Revoked or signed out for good: back to a fresh terminal. */
    reset: () => ({ ...sessionInitial, phase: "unenrolled" as const }),
  },
});

// --- ui ------------------------------------------------------------------------------------------------------------

export type ModePreference = "system" | "light" | "dark";

export interface UiState {
  leftHanded: boolean;
  modePreference: ModePreference;
  /** Branch or tenant theme id (from the synced theme dataset); "platform" until one is loaded. */
  themeId: string;
}

export const uiInitial: UiState = {
  leftHanded: false,
  modePreference: "system",
  themeId: "platform",
};

export const uiSlice = createSlice({
  name: "ui",
  initialState: uiInitial,
  reducers: {
    setLeftHanded(state, a: PayloadAction<boolean>) {
      state.leftHanded = a.payload;
    },
    setModePreference(state, a: PayloadAction<ModePreference>) {
      state.modePreference = a.payload;
    },
    setThemeId(state, a: PayloadAction<string>) {
      state.themeId = a.payload;
    },
  },
});

// --- cart ----------------------------------------------------------------------------------------------------------

export interface CartLine {
  readonly id: string;
  readonly variantId: string;
  readonly name: string;
  /** Decimal quantity as text (weighed goods): never a float. */
  readonly qty: string;
  readonly unitPriceMinor: number;
}

export const cartAdapter = createEntityAdapter<CartLine>();

/** Normalized: lines by id plus their order. The sell screen (P1-09) drives it; totals come from the pricing engine. */
export const cartSlice = createSlice({
  name: "cart",
  initialState: cartAdapter.getInitialState({ customerId: null as string | null }),
  reducers: {
    lineAdded(state, a: PayloadAction<CartLine>) {
      cartAdapter.addOne(state, a.payload);
    },
    lineQuantityChanged(state, a: PayloadAction<{ id: string; qty: string }>) {
      cartAdapter.updateOne(state, { id: a.payload.id, changes: { qty: a.payload.qty } });
    },
    lineRemoved(state, a: PayloadAction<string>) {
      cartAdapter.removeOne(state, a.payload);
    },
    customerSet(state, a: PayloadAction<string | null>) {
      state.customerId = a.payload;
    },
    cleared(state) {
      cartAdapter.removeAll(state);
      state.customerId = null;
    },
  },
});
