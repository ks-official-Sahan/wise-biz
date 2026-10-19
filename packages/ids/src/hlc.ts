/** Hybrid logical clock (Kulkarni et al.). Universal, no IO. */

export interface HlcTimestamp {
  wallMs: number;
  counter: number;
  node: string;
}

export interface HlcOptions {
  node: string;
  now?: () => number;
  /** Max accepted remote lead over local physical time. Default 5 min. */
  maxDriftMs?: number;
}

export interface Hlc {
  now(): HlcTimestamp;
  receive(remote: HlcTimestamp): HlcTimestamp;
}

const MAX_COUNTER = 0xffff;
const MAX_WALL = 9_999_999_999_999;

export class HlcDriftError extends Error {
  readonly driftMs: number;
  constructor(driftMs: number, maxDriftMs: number) {
    super(`Remote clock is ${String(driftMs)}ms ahead (max ${String(maxDriftMs)}ms)`);
    this.name = "HlcDriftError";
    this.driftMs = driftMs;
  }
}

/** Counter exceeded 0xffff within one wall ms. Thrown rather than advancing wall, so drift stays bounded. */
export class HlcCounterOverflowError extends Error {
  constructor() {
    super("HLC counter overflow");
    this.name = "HlcCounterOverflowError";
  }
}

export function createHlc(options: HlcOptions): Hlc {
  const { node, now = Date.now, maxDriftMs = 300_000 } = options;
  let wall = 0;
  let counter = 0;

  const commit = (w: number, c: number): HlcTimestamp => {
    if (c > MAX_COUNTER) throw new HlcCounterOverflowError();
    wall = w;
    counter = c;
    return { wallMs: wall, counter, node };
  };

  return {
    now() {
      const pt = now();
      return pt > wall ? commit(pt, 0) : commit(wall, counter + 1);
    },
    receive(remote) {
      const pt = now();
      const drift = remote.wallMs - pt;
      if (drift > maxDriftMs) throw new HlcDriftError(drift, maxDriftMs);
      const w = Math.max(wall, remote.wallMs, pt);
      if (w === pt && pt > wall && pt > remote.wallMs) return commit(w, 0);
      const l = w === wall ? counter : -1;
      const r = w === remote.wallMs ? remote.counter : -1;
      return commit(w, Math.max(l, r) + 1);
    },
  };
}

export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): -1 | 0 | 1 {
  if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node === b.node) return 0;
  return a.node < b.node ? -1 : 1;
}

/** `<13-digit ms>-<4 hex counter>-<node>`; lexical order equals compareHlc order. */
export function serializeHlc(t: HlcTimestamp): string {
  if (!Number.isInteger(t.wallMs) || t.wallMs < 0 || t.wallMs > MAX_WALL)
    throw new RangeError("wallMs out of range");
  if (!Number.isInteger(t.counter) || t.counter < 0 || t.counter > MAX_COUNTER)
    throw new RangeError("counter out of range");
  if (t.node === "") throw new RangeError("node must not be empty");
  return `${String(t.wallMs).padStart(13, "0")}-${t.counter.toString(16).padStart(4, "0")}-${t.node}`;
}

const HLC_RE = /^(\d{13})-([0-9a-f]{4})-(.+)$/s;

export function parseHlc(s: string): HlcTimestamp {
  const m = HLC_RE.exec(s);
  if (!m) throw new TypeError("Invalid HLC string");
  return { wallMs: Number(m[1]), counter: Number.parseInt(m[2] ?? "", 16), node: m[3] ?? "" };
}
