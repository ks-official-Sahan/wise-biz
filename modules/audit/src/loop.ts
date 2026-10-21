import { errorInfo, safely } from "./types.ts";

import type { AuditLogger, AuditOnMetric } from "./types.ts";

/** Stop signal with an abortable sleep. */
export function createStopper(): {
  isStopping(): boolean;
  stop(): void;
  sleep(ms: number): Promise<void>;
} {
  let stopping = false;
  const wakers = new Set<() => void>();
  return {
    isStopping: () => stopping,
    stop() {
      stopping = true;
      for (const w of [...wakers]) w();
    },
    sleep: (ms) =>
      new Promise((resolve) => {
        if (stopping) {
          resolve();
          return;
        }
        const done = (): void => {
          clearTimeout(t);
          wakers.delete(done);
          resolve();
        };
        const t = setTimeout(done, ms);
        wakers.add(done);
      }),
  };
}

export type PeriodicOptions = Readonly<{
  name: string;
  intervalMs: number;
  /** One run. Errors are logged + counted and never end the loop. */
  run: () => Promise<void>;
  logger: AuditLogger;
  onMetric?: AuditOnMetric | undefined;
  /** Run immediately on start (default true). */
  runAtStart?: boolean;
}>;

export interface Periodic {
  start(): void;
  /** One guarded run (same error handling as the loop); never throws. */
  runOnce(): Promise<void>;
  /** Abort the sleep; resolves once the in-flight run finishes. */
  stop(): Promise<void>;
}

/** Fixed-delay, stop-aware periodic job. */
export function createPeriodic(opts: PeriodicOptions): Periodic {
  const { name, intervalMs, logger, onMetric } = opts;
  const stopper = createStopper();
  let loop: Promise<void> | undefined;

  const runOnce = async (): Promise<void> => {
    try {
      await opts.run();
    } catch (e) {
      safely(() => {
        logger.error({ job: name, err: errorInfo(e) }, "audit job failed");
      });
      safely(() => onMetric?.("audit_job_error", 1, { job: name }));
    }
  };

  const main = async (): Promise<void> => {
    if (opts.runAtStart ?? true) await runOnce();
    while (!stopper.isStopping()) {
      await stopper.sleep(intervalMs);
      if (stopper.isStopping()) break;
      await runOnce();
    }
  };

  return {
    start() {
      loop ??= main();
    },
    runOnce,
    async stop() {
      stopper.stop();
      await loop;
    },
  };
}
