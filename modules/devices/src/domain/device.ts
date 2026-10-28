import { sha256, toHex } from "@wise-biz/crypto";

/** Crockford base32 without I, L, O, U: no look-alike characters when a code is typed on a terminal. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
/** The same alphabet as a pattern (no I, L, O, U). */
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const CODE_TTL_MS = 15 * 60 * 1000;

export const DEVICE_STATUSES = [
  "pending",
  "active",
  "suspended",
  "revoked",
  "blacklisted",
] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];
export const PLATFORMS = ["android", "ios", "windows", "macos", "linux", "web"] as const;

/** Revoked and blacklisted are terminal: the device must enroll again with a new key. */
const TRANSITIONS: Readonly<Record<DeviceStatus, readonly DeviceStatus[]>> = {
  pending: ["active", "revoked"],
  active: ["suspended", "revoked", "blacklisted"],
  suspended: ["active", "revoked", "blacklisted"],
  revoked: [],
  blacklisted: [],
};

export function canTransition(from: DeviceStatus, to: DeviceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 40 bits from the CSPRNG, shown as XXXX-XXXX. Unbiased: 256 is a multiple of 32. */
export function newEnrollmentCode(random: (n: number) => Uint8Array = randomBytes): string {
  const chars = Array.from(random(CODE_LENGTH), (b) => ALPHABET[b % 32] ?? "0");
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Upper-cases, drops separators and maps the Crockford look-alikes (O→0, I/L→1); null when not a code. */
export function normaliseCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE.test(s) ? s : null;
}

/** Hex SHA-256 of the normalised code: the only form stored or used as a lookup key. */
export function codeHash(normalised: string): string {
  return toHex(sha256(`wb-enroll:v1:${normalised}`));
}
