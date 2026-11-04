import type { DisplayState, ScreenInfo } from "../shared/channels.ts";

export class DisplayError extends Error {
  override readonly name = "DisplayError";
}

const MAX_LINES = 60;
const MAX_TEXT = 120;
const MAX_MINOR = Number.MAX_SAFE_INTEGER;

const isMinor = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= MAX_MINOR;
const text = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length <= max;

/** Validates what the till pushes to the second screen: bounded, plain data. The page renders it with textContent only. */
export function parseDisplayState(raw: unknown): DisplayState {
  if (typeof raw !== "object" || raw === null) throw new DisplayError("Invalid display state.");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.lines) || r.lines.length > MAX_LINES)
    throw new DisplayError("Invalid display lines.");
  const lines = (r.lines as unknown[]).map((l) => {
    const o = (typeof l === "object" && l !== null ? l : {}) as Record<string, unknown>;
    if (!text(o.name) || !text(o.qty, 16) || !isMinor(o.totalMinor))
      throw new DisplayError("Invalid display line.");
    return { name: o.name, qty: o.qty, totalMinor: o.totalMinor };
  });
  if (!isMinor(r.totalMinor) || !isMinor(r.changeMinor))
    throw new DisplayError("Invalid display amounts.");
  if (typeof r.currency !== "string" || !/^[A-Z]{3}$/.test(r.currency))
    throw new DisplayError("Invalid currency.");
  if (r.message !== undefined && !text(r.message)) throw new DisplayError("Invalid message.");
  if (r.qrUrl !== undefined && !text(r.qrUrl, 300)) throw new DisplayError("Invalid link.");
  return {
    lines,
    totalMinor: r.totalMinor,
    changeMinor: r.changeMinor,
    currency: r.currency,
    ...(r.message === undefined ? {} : { message: r.message }),
    ...(r.qrUrl === undefined ? {} : { qrUrl: r.qrUrl }),
  };
}

export interface DisplayWindow {
  send: (state: DisplayState | null) => void;
  close: () => void;
  isLoaded: () => boolean;
  /** True once the window is gone (closed by the user or the OS), so the controller opens a new one. */
  isClosed?: () => boolean;
}

/**
 * The customer-facing screen. Nothing opens until the till names a screen; the window is created on the first state,
 * moved when another screen is chosen, and closed on `choose(null)`. The latest state is replayed to a window that is
 * still loading, so the first push is never lost.
 */
export function createDisplayController(o: {
  screens: () => ScreenInfo[];
  /** The screen holding the till itself: the display never opens on top of it. */
  primaryId: () => number | undefined;
  open: (screenId: number) => DisplayWindow;
  load: () => number | null;
  save: (screenId: number | null) => void;
}) {
  let chosen: number | null = o.load();
  let win: DisplayWindow | undefined;
  let openedOn: number | undefined;
  let last: DisplayState | null = null;

  const ensure = (): DisplayWindow | undefined => {
    if (chosen === null || chosen === o.primaryId()) return undefined;
    if (!o.screens().some((s) => s.id === chosen)) return undefined;
    if (win?.isClosed?.() === true) {
      win = undefined;
      openedOn = undefined;
    }
    if (win !== undefined && openedOn !== chosen) {
      win.close();
      win = undefined;
    }
    if (win === undefined) {
      win = o.open(chosen);
      openedOn = chosen;
    }
    return win;
  };

  return {
    screens: (): ScreenInfo[] => o.screens(),
    chosen: (): number | null => chosen,
    choose(id: unknown): void {
      if (id !== null && (typeof id !== "number" || !Number.isInteger(id)))
        throw new DisplayError("Invalid screen.");
      chosen = id;
      o.save(id);
      if (id === null) {
        win?.close();
        win = undefined;
        return;
      }
      ensure()?.send(last);
    },
    show(raw: unknown): void {
      last = parseDisplayState(raw);
      ensure()?.send(last);
    },
    clear(): void {
      last = null;
      win?.send(null);
    },
    closeAll(): void {
      win?.close();
      win = undefined;
    },
  };
}

export type DisplayController = ReturnType<typeof createDisplayController>;
