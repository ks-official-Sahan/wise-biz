/**
 * Keyboard-wedge scanner detection. A scanner types a whole code in a burst (a few ms between keys) and ends with
 * Enter; a person types at 100 ms or more. Fed one key at a time, so it works from any key handler, anywhere on the
 * screen, with no focused input.
 */
export interface WedgeOptions {
  /** Longest gap between two keys of one burst. Scanners are under 30 ms; people are over 80 ms. */
  readonly maxGapMs?: number;
  /** Shortest code worth reporting (shorter bursts are typing). */
  readonly minLength?: number;
  readonly maxLength?: number;
}

export type WedgeResult =
  /** A scanned code is complete. */
  | { readonly type: "scan"; readonly code: string }
  /** The keys so far look like a scanner: swallow them (do not type them into a field). */
  | { readonly type: "capturing" }
  /** Ordinary typing: let it through. */
  | { readonly type: "pass" };

export function createWedgeDetector(options: WedgeOptions = {}) {
  const maxGap = options.maxGapMs ?? 30;
  const minLength = options.minLength ?? 4;
  const maxLength = options.maxLength ?? 64;
  let buffer = "";
  let last = Number.NEGATIVE_INFINITY;
  let burst = false;

  const reset = (): void => {
    buffer = "";
    burst = false;
  };

  return {
    /** `key` is `KeyboardEvent.key`; `t` is a monotonic millisecond clock. */
    push(key: string, t: number): WedgeResult {
      const gap = t - last;
      last = t;
      if (gap > maxGap) reset();
      if (key === "Enter") {
        const code = buffer;
        const wasBurst = burst;
        reset();
        return wasBurst && code.length >= minLength ? { type: "scan", code } : { type: "pass" };
      }
      if (key.length !== 1) {
        reset();
        return { type: "pass" };
      }
      if (buffer.length > 0 && gap <= maxGap) burst = true;
      buffer = (buffer + key).slice(-maxLength);
      return burst ? { type: "capturing" } : { type: "pass" };
    },
    reset,
  };
}

export type WedgeDetector = ReturnType<typeof createWedgeDetector>;
