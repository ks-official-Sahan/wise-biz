import { describe, expect, it } from "vitest";

import { createDisplayController, parseDisplayState } from "../src/main/display.ts";
import { createKiosk, isBlockedKioskKey, parseKioskRecord } from "../src/main/kiosk.ts";

import type { KioskRecord } from "../src/main/kiosk.ts";
import type { DisplayState, ScreenInfo } from "../src/shared/channels.ts";

const state: DisplayState = {
  lines: [{ name: "Green Tea", qty: "2", totalMinor: 1006 }],
  totalMinor: 1006,
  changeMinor: 0,
  currency: "USD",
};

describe("display state", () => {
  it("accepts a bounded plain state", () => {
    expect(
      parseDisplayState({ ...state, message: "Thank you", qrUrl: "https://r.example/ABC" }),
    ).toEqual({
      ...state,
      message: "Thank you",
      qrUrl: "https://r.example/ABC",
    });
    expect(parseDisplayState({ ...state, extra: "dropped" })).toEqual(state);
  });

  it("refuses anything else", () => {
    const bad: unknown[] = [
      null,
      "x",
      { ...state, lines: "no" },
      { ...state, lines: new Array(61).fill(state.lines[0]) },
      { ...state, lines: [{ name: "x".repeat(121), qty: "1", totalMinor: 1 }] },
      { ...state, lines: [{ name: "x", qty: "1", totalMinor: -1 }] },
      { ...state, lines: [null] },
      { ...state, totalMinor: 1.5 },
      { ...state, changeMinor: Number.MAX_SAFE_INTEGER + 2 },
      { ...state, currency: "usd" },
      { ...state, message: "m".repeat(121) },
      { ...state, qrUrl: "u".repeat(301) },
    ];
    for (const b of bad)
      expect(() => parseDisplayState(b), JSON.stringify(b).slice(0, 60)).toThrow();
  });
});

describe("display controller", () => {
  const screens: ScreenInfo[] = [
    { id: 1, label: "Till", primary: true, width: 1920, height: 1080 },
    { id: 2, label: "Customer", primary: false, width: 1280, height: 720 },
    { id: 3, label: "Other", primary: false, width: 1280, height: 720 },
  ];
  function make(initial: number | null = null) {
    let gone = false;
    const opened: number[] = [];
    const sent: (DisplayState | null)[] = [];
    let closed = 0;
    const saved: (number | null)[] = [];
    const c = createDisplayController({
      screens: () => screens,
      primaryId: () => 1,
      open: (id) => {
        opened.push(id);
        return {
          send: (s) => void sent.push(s),
          close: () => {
            closed++;
          },
          isLoaded: () => true,
          isClosed: () => gone,
        };
      },
      load: () => initial,
      save: (id) => void saved.push(id),
    });
    return {
      c,
      opened,
      sent,
      saved,
      closed: () => closed,
      /** The window disappears on its own (the OS or the customer closed it). */
      vanish: () => {
        gone = true;
      },
      reappear: () => {
        gone = false;
      },
    };
  }

  it("opens nothing until a screen is chosen, and never on the till screen", () => {
    const t = make();
    t.c.show(state);
    expect(t.opened).toEqual([]);
    t.c.choose(1);
    t.c.show(state);
    expect(t.opened).toEqual([]);
    t.c.choose(99);
    t.c.show(state);
    expect(t.opened).toEqual([]);
  });

  it("opens a new window when the customer screen was closed from outside", () => {
    const t = make();
    t.c.choose(2);
    t.c.show(state);
    expect(t.opened).toEqual([2]);
    t.vanish();
    t.reappear(); // a new window opens fresh, so the flag is for the old one only
    t.c.show({ ...state, changeMinor: 5 });
    expect(t.opened).toEqual([2]);
    t.vanish();
    t.c.show({ ...state, changeMinor: 6 });
    expect(t.opened).toEqual([2, 2]);
  });

  it("opens on the chosen screen, replays the latest state, moves and closes", () => {
    const t = make();
    t.c.show(state);
    t.c.choose(2);
    expect(t.opened).toEqual([2]);
    expect(t.sent).toEqual([state]);
    t.c.show({ ...state, changeMinor: 94 });
    expect(t.opened).toEqual([2]);
    t.c.choose(3);
    expect(t.opened).toEqual([2, 3]);
    expect(t.closed()).toBe(1);
    t.c.clear();
    expect(t.sent.at(-1)).toBeNull();
    t.c.choose(null);
    expect(t.closed()).toBe(2);
    expect(t.saved).toEqual([2, 3, null]);
    t.c.closeAll();
    expect(() => {
      t.c.choose("2");
    }).toThrow("Invalid screen");
    expect(() => {
      t.c.choose(1.5);
    }).toThrow("Invalid screen");
  });

  it("remembers the chosen screen across restarts", () => {
    const t = make(2);
    expect(t.c.chosen()).toBe(2);
    t.c.show(state);
    expect(t.opened).toEqual([2]);
    expect(t.c.screens()).toHaveLength(3);
  });
});

describe("kiosk", () => {
  function make(record?: KioskRecord) {
    let clock = 1_000_000;
    const applied: boolean[] = [];
    let saved: KioskRecord | undefined = record;
    const k = createKiosk({
      load: () => saved,
      save: (r) => {
        saved = r;
      },
      now: () => clock,
      apply: (e) => void applied.push(e),
    });
    return { k, applied, tick: (ms: number) => void (clock += ms), saved: () => saved };
  }

  it("needs a PIN before it can be turned on, and the PIN to turn it off", () => {
    const t = make();
    expect(t.k.status()).toEqual({ enabled: false, hasPin: false });
    expect(() => {
      t.k.setEnabled(true);
    }).toThrow("Set an admin PIN");
    expect(() => {
      t.k.setPin("12");
    }).toThrow("6 to 12 digits");
    expect(() => {
      t.k.setPin("12ab");
    }).toThrow("6 to 12 digits");
    t.k.setPin("432100");
    expect(JSON.stringify(t.saved())).not.toContain("432100");
    t.k.setEnabled(true);
    expect(t.k.status()).toEqual({ enabled: true, hasPin: true });
    expect(() => {
      t.k.setEnabled(false);
    }).toThrow("not right");
    expect(() => {
      t.k.setEnabled(false, "000000");
    }).toThrow("not right");
    t.k.setEnabled(false, "432100");
    expect(t.applied).toEqual([true, false]);
    expect(() => {
      t.k.setEnabled("yes");
    }).toThrow("Invalid request");
  });

  it("changes the PIN only with the current one", () => {
    const t = make();
    t.k.setPin("111111");
    expect(() => {
      t.k.setPin("222222");
    }).toThrow("not right");
    t.k.setPin("222222", "111111");
    expect(t.k.verify("222222")).toBe(true);
    expect(() => t.k.verify("111111")).toThrow("not right");
  });

  it("locks the check after five wrong tries and unlocks after 30 seconds", () => {
    const t = make();
    t.k.setPin("123456");
    for (let i = 0; i < 5; i++) expect(() => t.k.verify("000000")).toThrow("not right");
    expect(() => t.k.verify("123456")).toThrow("Too many attempts");
    t.tick(30_001);
    expect(t.k.verify("123456")).toBe(true);
  });

  it("applies the saved state at start and survives a restart", () => {
    const t = make();
    t.k.setPin("123456");
    t.k.setEnabled(true);
    const again = make(t.saved());
    again.k.start();
    expect(again.applied).toEqual([true]);
    expect(again.k.status()).toEqual({ enabled: true, hasPin: true });
  });

  it("blocks the keys that leave the sell screen", () => {
    for (const i of [
      { key: "F11" },
      { key: "F5" },
      { key: "F12" },
      { key: "F4", alt: true },
      { key: "ArrowLeft", alt: true },
      { key: "r", control: true },
      { key: "w", control: true },
      { key: "q", meta: true },
      { key: "I", control: true, shift: true },
    ])
      expect(isBlockedKioskKey(i), i.key).toBe(true);
    for (const i of [
      { key: "a" },
      { key: "Enter" },
      { key: "F9" },
      { key: "c", control: true },
      { key: "F4" },
    ])
      expect(isBlockedKioskKey(i), i.key).toBe(false);
  });
});

describe("kiosk hardening", () => {
  function make(record?: KioskRecord) {
    let clock = 1_000_000;
    let saved: KioskRecord | undefined = record;
    const k = createKiosk({
      load: () => saved,
      save: (r) => {
        saved = r;
      },
      now: () => clock,
      apply: () => undefined,
    });
    return { k, tick: (ms: number) => void (clock += ms), saved: () => saved };
  }

  it("keeps the failure count and the lockout across a restart", () => {
    const t = make();
    t.k.setPin("123456");
    for (let i = 0; i < 4; i++) expect(() => t.k.verify("000000")).toThrow("not right");
    // The process is killed here: a new instance reads the saved record and has one try left.
    const again = make(t.saved());
    expect(() => again.k.verify("000000")).toThrow("not right");
    expect(() => again.k.verify("123456")).toThrow("Too many attempts");
    const restarted = make(again.saved());
    expect(() => restarted.k.verify("123456")).toThrow("Too many attempts");
    restarted.tick(30_001);
    expect(restarted.k.verify("123456")).toBe(true);
    expect(restarted.saved()?.failures ?? 0).toBe(0);
  });

  it("opens the device settings for five minutes after the PIN, never before", () => {
    const t = make();
    t.k.guard();
    t.k.setPin("123456");
    expect(() => {
      t.k.guard();
    }).toThrow("Enter the admin PIN");
    t.k.verify("123456");
    t.k.guard();
    t.tick(5 * 60_000 + 1);
    expect(() => {
      t.k.guard();
    }).toThrow("Enter the admin PIN");
  });

  it("matches blocked keys by physical key, on any keyboard layout", () => {
    expect(isBlockedKioskKey({ key: "к", code: "KeyR", control: true })).toBe(true);
    expect(isBlockedKioskKey({ key: "ω", code: "KeyW", control: true })).toBe(true);
    expect(isBlockedKioskKey({ key: "a", code: "KeyA", control: true })).toBe(false);
  });

  it("treats a malformed kiosk file as no record", () => {
    expect(parseKioskRecord(null)).toBeUndefined();
    expect(parseKioskRecord({ enabled: "yes" })).toBeUndefined();
    expect(
      parseKioskRecord({
        enabled: true,
        pin: { salt: 1, hash: 2 },
        failures: -1,
        lockedUntil: "x",
      }),
    ).toEqual({
      enabled: true,
    });
    expect(
      parseKioskRecord({
        enabled: false,
        pin: { salt: "s", hash: "h" },
        failures: 2,
        lockedUntil: 5,
      }),
    ).toEqual({ enabled: false, pin: { salt: "s", hash: "h" }, failures: 2, lockedUntil: 5 });
  });
});
