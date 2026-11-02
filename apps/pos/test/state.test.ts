import { describe, expect, it, vi } from "vitest";

import { cartSlice, sessionSlice, uiSlice } from "../src/state/slices.ts";
import { createPosStore, loadPersisted } from "../src/state/store.ts";

import type { KeyValue } from "../src/state/store.ts";

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  const storage: KeyValue = {
    getItem: (k) => Promise.resolve(data.get(k) ?? null),
    setItem: (k, v) => {
      data.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k) => {
      data.delete(k);
      return Promise.resolve();
    },
  };
  return { storage, data };
};
const device = { deviceId: "d1", tenantId: "t1", branchId: "b1", name: "Till 1" };
const operator = { userId: "u1", sessionId: "s1", expiresAt: "2026-01-01T12:00:00Z" };

describe("session", () => {
  it("walks unenrolled -> enrolled -> locked -> unlocked and back to locked", () => {
    const s = sessionSlice.reducer;
    let state = s(undefined, sessionSlice.actions.booted({ device: null, lowTrust: true }));
    expect(state).toMatchObject({ phase: "unenrolled", lowTrust: true });
    state = s(state, sessionSlice.actions.enrolled(device));
    expect(state.phase).toBe("enrolled");
    state = s(state, sessionSlice.actions.ready());
    expect(state.phase).toBe("locked");
    state = s(state, sessionSlice.actions.unlocked(operator));
    expect(state).toMatchObject({ phase: "unlocked", operator });
    state = s(state, sessionSlice.actions.locked());
    expect(state).toMatchObject({ phase: "locked", operator: null });
  });

  it("a restart with a known device asks for the PIN, a block clears the operator, reset wipes the device", () => {
    const s = sessionSlice.reducer;
    expect(s(undefined, sessionSlice.actions.booted({ device, lowTrust: false })).phase).toBe(
      "locked",
    );
    const unlocked = s(
      s(undefined, sessionSlice.actions.booted({ device, lowTrust: false })),
      sessionSlice.actions.unlocked(operator),
    );
    const blocked = s(unlocked, sessionSlice.actions.blocked("revoked"));
    expect(blocked).toMatchObject({ phase: "blocked", blocked: "revoked", operator: null });
    expect(s(blocked, sessionSlice.actions.reset())).toMatchObject({
      phase: "unenrolled",
      device: null,
      blocked: null,
    });
    // `ready` and `locked` outside their phase change nothing.
    expect(s(unlocked, sessionSlice.actions.ready()).phase).toBe("unlocked");
    expect(s(undefined, sessionSlice.actions.locked()).phase).toBe("booting");
  });
});

describe("cart", () => {
  it("keeps lines normalized with their order and decimal quantities as text", () => {
    const c = cartSlice.reducer;
    let state = c(
      undefined,
      cartSlice.actions.lineAdded({
        id: "l1",
        variantId: "v1",
        name: "Tea",
        qty: "1",
        unitPriceMinor: 500,
      }),
    );
    state = c(
      state,
      cartSlice.actions.lineAdded({
        id: "l2",
        variantId: "v2",
        name: "Rice",
        qty: "0.750",
        unitPriceMinor: 300,
      }),
    );
    state = c(state, cartSlice.actions.lineQuantityChanged({ id: "l1", qty: "3" }));
    state = c(state, cartSlice.actions.customerSet("c1"));
    expect(state.ids).toEqual(["l1", "l2"]);
    expect(state.entities.l1?.qty).toBe("3");
    expect(state.entities.l2?.qty).toBe("0.750");
    state = c(state, cartSlice.actions.lineRemoved("l1"));
    expect(state.ids).toEqual(["l2"]);
    state = c(state, cartSlice.actions.cleared());
    expect(state).toMatchObject({ ids: [], customerId: null });
  });
});

describe("store and persistence", () => {
  it("saves UI preferences and the device summary, debounced, and never the operator or cart", async () => {
    vi.useFakeTimers();
    try {
      const m = memory();
      const store = createPosStore({ storage: m.storage, debounceMs: 100 });
      store.dispatch(sessionSlice.actions.booted({ device, lowTrust: false }));
      store.dispatch(sessionSlice.actions.unlocked(operator));
      store.dispatch(uiSlice.actions.setLeftHanded(true));
      store.dispatch(uiSlice.actions.setModePreference("dark"));
      store.dispatch(
        cartSlice.actions.lineAdded({
          id: "l1",
          variantId: "v1",
          name: "Tea",
          qty: "1",
          unitPriceMinor: 500,
        }),
      );
      expect(m.data.size).toBe(0);
      await vi.advanceTimersByTimeAsync(150);
      const saved = JSON.parse(m.data.get("wb.pos.state.v1") ?? "{}") as Record<string, unknown>;
      expect(saved).toEqual({
        ui: { leftHanded: true, modePreference: "dark", themeId: "platform" },
        device,
      });
      expect(JSON.stringify(saved)).not.toContain("s1");
      // An unrelated change (cart) does not rewrite the file.
      const before = m.data.get("wb.pos.state.v1");
      store.dispatch(cartSlice.actions.cleared());
      await vi.advanceTimersByTimeAsync(150);
      expect(m.data.get("wb.pos.state.v1")).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads what was saved and falls back to defaults for missing, corrupted or hostile values", async () => {
    const saved = JSON.stringify({
      ui: { leftHanded: true, modePreference: "light", themeId: "bakery" },
      device,
    });
    expect(await loadPersisted(memory({ "wb.pos.state.v1": saved }).storage)).toEqual({
      ui: { leftHanded: true, modePreference: "light", themeId: "bakery" },
      device,
    });
    const defaults = {
      ui: { leftHanded: false, modePreference: "system", themeId: "platform" },
      device: null,
    };
    expect(await loadPersisted(memory().storage)).toEqual(defaults);
    expect(await loadPersisted(memory({ "wb.pos.state.v1": "{not json" }).storage)).toEqual(
      defaults,
    );
    const hostile = JSON.stringify({
      ui: { leftHanded: "yes", modePreference: "neon", themeId: 7 },
    });
    expect(await loadPersisted(memory({ "wb.pos.state.v1": hostile }).storage)).toEqual(defaults);
    const broken: KeyValue = {
      ...memory().storage,
      getItem: () => Promise.reject(new Error("disk")),
    };
    expect(await loadPersisted(broken)).toEqual(defaults);
  });

  it("starts from preloaded UI preferences", () => {
    const store = createPosStore({
      storage: memory().storage,
      ui: { leftHanded: true, modePreference: "dark", themeId: "x" },
    });
    expect(store.getState().ui).toEqual({ leftHanded: true, modePreference: "dark", themeId: "x" });
    expect(store.getState().session.phase).toBe("booting");
  });
});
