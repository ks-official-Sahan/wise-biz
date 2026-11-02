import { createEntityAdapter, createSlice } from "@reduxjs/toolkit";

import { addQty } from "../features/sell/model/qty.ts";

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
  /** What this operator may do on the terminal (`all` for the owner); absent means nothing beyond selling. */
  permissions?: string[] | "all";
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
  readonly sku: string;
  readonly name: string;
  readonly taxCategory: string;
  readonly categoryIds: readonly string[];
  /** Decimal quantity as text (weighed goods): never a float. */
  readonly qty: string;
  /** When the line was added (ms): the undo window for removal without a permission runs from here. */
  readonly addedAt: number;
  /** Manual price per base unit, set only through an approved override or a price-label scan. */
  readonly priceOverrideMinor?: number;
  readonly note?: string;
}

/** A supervisor's approval of one action, kept with the cart so the sale command can carry it. */
export interface Approval {
  readonly id: string;
  readonly permission: string;
  readonly approverId: string;
  readonly requesterId: string;
  readonly reason: string;
  readonly subjectId: string;
  readonly at: number;
}

export const cartAdapter = createEntityAdapter<CartLine>();

export interface CartExtras {
  customerId: string | null;
  note: string | null;
  approvals: Approval[];
}

/** Normalized: lines by id plus their order. Totals come from the pricing engine, never from this state. */
export const cartSlice = createSlice({
  name: "cart",
  initialState: cartAdapter.getInitialState<CartExtras>({
    customerId: null,
    note: null,
    approvals: [],
  }),
  reducers: {
    /** Adds a line, or adds to the quantity of the line already holding that variant (same SKU merges). */
    lineAdded(state, a: PayloadAction<CartLine>) {
      const same = Object.values(state.entities).find(
        (l) =>
          l.variantId === a.payload.variantId &&
          l.priceOverrideMinor === a.payload.priceOverrideMinor,
      );
      if (same === undefined) {
        cartAdapter.addOne(state, a.payload);
        return;
      }
      const sum = addQty(same.qty, a.payload.qty);
      if (sum !== undefined) cartAdapter.updateOne(state, { id: same.id, changes: { qty: sum } });
    },
    lineQuantityChanged(state, a: PayloadAction<{ id: string; qty: string }>) {
      cartAdapter.updateOne(state, { id: a.payload.id, changes: { qty: a.payload.qty } });
    },
    lineNoted(state, a: PayloadAction<{ id: string; note: string | null }>) {
      const { id, note } = a.payload;
      cartAdapter.updateOne(state, { id, changes: note === null ? { note: "" } : { note } });
    },
    /** Removes several lines at once (parking takes only what it saved). */
    linesRemoved(state, a: PayloadAction<string[]>) {
      cartAdapter.removeMany(state, a.payload);
      if (state.ids.length === 0) {
        state.customerId = null;
        state.note = null;
        state.approvals = [];
      }
    },
    lineRemoved(state, a: PayloadAction<string>) {
      cartAdapter.removeOne(state, a.payload);
    },
    customerSet(state, a: PayloadAction<string | null>) {
      state.customerId = a.payload;
    },
    noteSet(state, a: PayloadAction<string | null>) {
      state.note = a.payload;
    },
    approvalRecorded(state, a: PayloadAction<Approval>) {
      state.approvals.push(a.payload);
    },
    /** Replaces the whole cart (resume of a parked sale). */
    restored(
      state,
      a: PayloadAction<{
        lines: CartLine[];
        customerId: string | null;
        note: string | null;
        approvals: Approval[];
      }>,
    ) {
      cartAdapter.setAll(state, a.payload.lines);
      state.customerId = a.payload.customerId;
      state.note = a.payload.note;
      state.approvals = a.payload.approvals;
    },
    cleared(state) {
      cartAdapter.removeAll(state);
      state.customerId = null;
      state.note = null;
      state.approvals = [];
    },
  },
});
