/** UUIDv7 (RFC 9562), monotonic. Universal: only `globalThis.crypto.getRandomValues`. */

export interface Uuidv7Deps {
  now: () => number;
  random: (bytes: Uint8Array) => void;
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_COUNTER = 0xfff;
const POOL_SIZE = 1024;

/**
 * Layout: 48-bit ms | ver 7 | 12-bit counter (rand_a) | var 10 | 62 random bits.
 * Counter is seeded random with its top bit cleared (headroom of >= 2048 ids/ms).
 * On counter overflow the stored timestamp advances 1 ms (virtual clock) and reseeds.
 * The stored timestamp never decreases, even if the system clock does.
 */
export function createUuidv7(deps: Uuidv7Deps): () => string {
  const pool = new Uint8Array(POOL_SIZE);
  let offset = POOL_SIZE;
  let lastMs = -1;
  let counter = 0;

  const take = (n: number): number => {
    if (offset + n > POOL_SIZE) {
      deps.random(pool);
      offset = 0;
    }
    const start = offset;
    offset += n;
    return start;
  };

  const reseed = (): void => {
    const i = take(2);
    counter = (((byte(pool, i) & 0x07) << 8) | byte(pool, i + 1)) & 0x7ff;
  };

  return () => {
    const nowMs = Math.floor(deps.now());
    if (nowMs > lastMs) {
      lastMs = nowMs;
      reseed();
    } else if (counter >= MAX_COUNTER) {
      lastMs += 1;
      reseed();
    } else {
      counter += 1;
    }

    const r = take(8);
    const b = new Uint8Array(16);
    // 48-bit timestamp; split to stay within safe integer arithmetic.
    const hi = Math.floor(lastMs / 0x1_0000_0000);
    const lo = lastMs >>> 0;
    b[0] = (hi >>> 8) & 0xff;
    b[1] = hi & 0xff;
    b[2] = lo >>> 24;
    b[3] = (lo >>> 16) & 0xff;
    b[4] = (lo >>> 8) & 0xff;
    b[5] = lo & 0xff;
    b[6] = 0x70 | (counter >>> 8);
    b[7] = counter & 0xff;
    b[8] = 0x80 | (byte(pool, r) & 0x3f);
    for (let k = 1; k < 8; k++) b[8 + k] = byte(pool, r + k);
    return format(b);
  };
}

function byte(a: Uint8Array, i: number): number {
  return a[i] ?? 0;
}

function format(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    s += HEX[b[i] ?? 0] ?? "";
  }
  return s;
}

/** Default generator: Date.now + crypto.getRandomValues. */
export const uuidv7: () => string = createUuidv7({
  now: () => Date.now(),
  random: (bytes) => {
    globalThis.crypto.getRandomValues(bytes);
  },
});

export function isUuidv7(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Unix ms embedded in a UUIDv7. Throws TypeError for anything else. */
export function timestampOf(id: string): number {
  if (!isUuidv7(id)) throw new TypeError("Not a UUIDv7");
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
