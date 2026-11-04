/**
 * Exponential backoff with full jitter: a random delay in [0, min(cap, base * 2^attempt)), never shorter than the
 * server's `Retry-After`. Full jitter keeps a fleet that lost the network together from reconnecting together.
 */
export function backoffDelay(opts: {
  attempt: number;
  baseMs: number;
  capMs: number;
  random: () => number;
  retryAfterMs?: number | undefined;
}): number {
  const ceiling = Math.min(opts.capMs, opts.baseMs * 2 ** opts.attempt);
  return Math.max(Math.floor(opts.random() * ceiling), opts.retryAfterMs ?? 0);
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

/** A wait that `wake()` can end early (the network came back, the loop is stopping). */
export function createSleeper(timers: Timers) {
  let wake: (() => void) | undefined;
  return {
    sleep: (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        const handle = timers.set(() => {
          wake = undefined;
          resolve();
        }, ms);
        wake = () => {
          timers.clear(handle);
          wake = undefined;
          resolve();
        };
      }),
    wake: (): void => {
      wake?.();
    },
  };
}

/** Metric names the client emits; the host maps them to its logger or telemetry. */
export type ClientMetric =
  | "push_batch_ms"
  | "pull_page_ms"
  | "pull_apply_ms"
  | "bootstrap_ms"
  | "sync_lag_ms"
  | "unsynced_count";
export type OnClientMetric = (
  name: ClientMetric,
  value: number,
  labels: Record<string, string>,
) => void;
