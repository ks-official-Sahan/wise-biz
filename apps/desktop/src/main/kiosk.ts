import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import type { KioskStatus } from "../shared/channels.ts";

export interface KioskRecord {
  readonly enabled: boolean;
  /** scrypt of the admin PIN: salt and hash, base64. Absent until an admin PIN is set. */
  readonly pin?: { readonly salt: string; readonly hash: string };
  /** Wrong tries so far and the end of the current lockout (ms since epoch), kept across restarts. */
  readonly failures?: number;
  readonly lockedUntil?: number;
}

/** Reads `kiosk.json`: anything that is not the expected shape counts as no record. */
export function parseKioskRecord(raw: unknown): KioskRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return undefined;
  const pin = r.pin as { salt?: unknown; hash?: unknown } | undefined;
  const okPin = pin !== undefined && typeof pin.salt === "string" && typeof pin.hash === "string";
  return {
    enabled: r.enabled,
    ...(okPin ? { pin: { salt: pin.salt as string, hash: pin.hash as string } } : {}),
    ...(typeof r.failures === "number" && Number.isInteger(r.failures) && r.failures >= 0
      ? { failures: r.failures }
      : {}),
    ...(typeof r.lockedUntil === "number" && Number.isFinite(r.lockedUntil)
      ? { lockedUntil: r.lockedUntil }
      : {}),
  };
}

export class KioskError extends Error {
  override readonly name = "KioskError";
}

const MAX_FAILURES = 5;
const LOCKOUT_MS = 30_000;
/** After a right PIN the device settings stay open this long. */
const UNLOCK_MS = 5 * 60_000;

const hashPin = (pin: string, salt: Buffer): Buffer =>
  scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });

const validPin = (pin: unknown): pin is string => typeof pin === "string" && /^\d{6,12}$/.test(pin);

/**
 * Keys that would take a terminal out of its sell screen: reload, close, quit, devtools, fullscreen toggle, navigation.
 * (The operating system keeps Ctrl+Alt+Del and the Windows key; those are a kiosk policy of the machine, see
 * docs/features/payments-hardware.md.)
 */
export function isBlockedKioskKey(i: {
  key: string;
  /** Physical key (`KeyR`): matches on any keyboard layout, where `key` would be a Cyrillic or Greek letter. */
  code?: string;
  control?: boolean;
  alt?: boolean;
  meta?: boolean;
  shift?: boolean;
}): boolean {
  const k =
    i.code?.startsWith("Key") === true ? i.code.slice(3).toLowerCase() : i.key.toLowerCase();
  if (k === "f11" || k === "f5" || k === "f12" || (k === "f4" && i.alt === true)) return true;
  if (i.alt === true && (k === "arrowleft" || k === "arrowright" || k === "f4")) return true;
  if ((i.control === true || i.meta === true) && ["r", "w", "q", "n", "t", "p", "l"].includes(k))
    return true;
  if (
    (i.control === true || i.meta === true) &&
    i.shift === true &&
    ["i", "j", "c", "r"].includes(k)
  )
    return true;
  return false;
}

/**
 * The admin PIN that guards the device settings and the way out of kiosk mode. Stored as a salted scrypt hash, compared
 * in constant time, and five wrong tries lock the check for 30 seconds (the counter is in memory: a restart is a
 * restart of the terminal, not a way to probe faster, because each try costs one scrypt).
 */
export function createKiosk(o: {
  load: () => KioskRecord | undefined;
  save: (r: KioskRecord) => void;
  now: () => number;
  apply: (enabled: boolean) => void;
}) {
  let record: KioskRecord = o.load() ?? { enabled: false };
  let unlockedUntil = 0;

  const commit = (next: KioskRecord): void => {
    record = next;
    o.save(next);
  };

  const verify = (pin: unknown): boolean => {
    if (record.pin === undefined) return true;
    if (o.now() < (record.lockedUntil ?? 0))
      throw new KioskError("Too many attempts. Wait a moment and try again.");
    const ok =
      validPin(pin) &&
      timingSafeEqual(
        hashPin(pin, Buffer.from(record.pin.salt, "base64")),
        Buffer.from(record.pin.hash, "base64"),
      );
    if (ok) {
      if ((record.failures ?? 0) > 0) commit({ ...record, failures: 0 });
      unlockedUntil = o.now() + UNLOCK_MS;
      return true;
    }
    // Counted on disk: killing the process does not hand out fresh tries.
    const failures = (record.failures ?? 0) + 1;
    commit(
      failures >= MAX_FAILURES
        ? { ...record, failures: 0, lockedUntil: o.now() + LOCKOUT_MS }
        : { ...record, failures },
    );
    throw new KioskError("That PIN is not right.");
  };

  return {
    status: (): KioskStatus => ({ enabled: record.enabled, hasPin: record.pin !== undefined }),
    /** Applies the saved state at startup. */
    start: (): void => {
      o.apply(record.enabled);
    },
    /** Sets the first PIN, or changes it with the current one. */
    setPin(pin: unknown, current?: unknown): void {
      if (!validPin(pin)) throw new KioskError("The PIN is 6 to 12 digits.");
      verify(current);
      const salt = randomBytes(16);
      commit({
        ...record,
        pin: { salt: salt.toString("base64"), hash: hashPin(pin, salt).toString("base64") },
      });
    },
    verify,
    /** Device settings (printer, display) change only after the admin PIN was entered in the last 5 minutes. */
    guard(): void {
      if (record.pin !== undefined && o.now() >= unlockedUntil)
        throw new KioskError("Enter the admin PIN to change devices.");
    },
    /** Turning kiosk on needs a PIN to exist (otherwise nobody could leave it); turning it off needs that PIN. */
    setEnabled(enabled: unknown, pin?: unknown): void {
      if (typeof enabled !== "boolean") throw new KioskError("Invalid request.");
      if (enabled && record.pin === undefined)
        throw new KioskError("Set an admin PIN before turning on kiosk mode.");
      if (!enabled) verify(pin);
      commit({ ...record, enabled });
      o.apply(enabled);
    },
  };
}

export type Kiosk = ReturnType<typeof createKiosk>;
