import type { OnSyncMetric } from "@wise-biz/module-sync";

/** Structural subset of a pino logger. */
interface InfoLogger {
  info(obj: object, msg?: string): void;
}

export interface SyncMetrics {
  onMetric: OnSyncMetric;
  /** Log and reset the current window; returns what was logged (null when nothing happened). */
  flush: () => Record<string, number> | null;
  start: () => void;
  stop: () => void;
}

const SAMPLE_CAP = 10_000;
const WINDOW_MS = 60_000;

const quantile = (sorted: readonly number[], q: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0);

/**
 * Per-minute window over the sync push path: commands applied, rejected, batches stopped, and apply latency
 * (p50/p95/max of one command's transaction). The window is bounded (a 10k-sample reservoir), so a burst costs
 * constant memory. Emitted as one structured log line a minute, like the workers' metrics.
 */
export function createSyncMetrics(logger: InfoLogger): SyncMetrics {
  let samples: number[] = [];
  let seen = 0;
  let applied = 0;
  let replayed = 0;
  let rejected = 0;
  let stopped = 0;
  let batches = 0;
  let commandsInBatches = 0;
  let timer: NodeJS.Timeout | undefined;

  const onMetric: OnSyncMetric = (name, value, labels) => {
    if (name === "sync_apply_ms") {
      seen++;
      if (samples.length < SAMPLE_CAP) samples.push(value);
      else {
        // Reservoir sampling: every observation has the same chance of being kept, and the array never grows.
        const j = Math.floor(Math.random() * seen);
        if (j < SAMPLE_CAP) samples[j] = value;
      }
      if (labels.status === "applied") applied++;
      else if (labels.status === "replayed") replayed++;
      else if (labels.status === "rejected") rejected++;
    } else if (name === "sync_stopped") stopped += value;
    else {
      batches++;
      commandsInBatches += value;
    }
  };

  const flush = (): Record<string, number> | null => {
    if (seen === 0 && stopped === 0 && batches === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const out = {
      commands: seen,
      applied,
      replayed,
      rejected,
      stoppedBatches: stopped,
      batches,
      avgBatchSize: batches === 0 ? 0 : Math.round(commandsInBatches / batches),
      applyP50Ms: Math.round(quantile(sorted, 0.5) * 10) / 10,
      applyP95Ms: Math.round(quantile(sorted, 0.95) * 10) / 10,
      applyMaxMs: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
    };
    samples = [];
    seen = applied = replayed = rejected = stopped = batches = commandsInBatches = 0;
    logger.info(out, "sync push window");
    return out;
  };

  return {
    onMetric,
    flush,
    start: () => {
      timer ??= setInterval(flush, WINDOW_MS);
      timer.unref();
    },
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
