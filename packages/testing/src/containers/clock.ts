export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

/** Deterministic clock for tests. Inject wherever domain code takes a Clock. */
export function fakeClock(startMs = 0): FakeClock {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
    set(ms) {
      current = ms;
    },
  };
}
