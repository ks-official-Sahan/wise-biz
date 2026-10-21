import type { ConsumerDefinition } from "./consumer.ts";
import type { BusLogger, EventMessage, OnMetric } from "./message.ts";

export type BackoffOptions = Readonly<{
  /** First retry delay (default 100 ms); doubles each retry. */
  baseMs?: number;
  /** Returns [0,1); default Math.random. Delay = exp * (0.5 + random()/2). */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>;

export const MAX_ERROR_CHARS = 1000;
export const MAX_LOG_ERROR_CHARS = 200;

export const truncateError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);

/** Run a side-effect hook (log / metric) that must never change delivery. Swallows anything it throws. */
export function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // observability must not affect delivery
  }
}

/** Loggable error summary: class, code, first line cut to 200 chars. Never payload, stack or pg detail. */
export function describeError(err: unknown): {
  errorClass: string;
  code?: string | number;
  error: string;
} {
  const raw = err instanceof Error ? err.message : String(err);
  const error = (raw.split("\n", 1)[0] ?? "").slice(0, MAX_LOG_ERROR_CHARS);
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return {
    errorClass: err instanceof Error ? err.constructor.name : typeof err,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    error,
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type DeliverDeps = Readonly<{
  logger: BusLogger;
  onMetric?: OnMetric | undefined;
  backoff?: BackoffOptions | undefined;
}>;

/**
 * Run `attemptOnce` up to consumer.maxAttempts with exponential backoff.
 * `attemptOnce` returns "done" | "duplicate" or throws. After the last failure `deadLetter` is called.
 * Returns "ok" (handled or parked) or "failed" (parking itself failed: the caller must not treat the
 * event as delivered). Logs and metrics are wrapped in `safe` and sit outside every try that decides
 * the outcome, so a throwing hook after a commit can never cause a retry or a dead letter.
 */
export async function deliver(
  deps: DeliverDeps,
  consumer: ConsumerDefinition,
  event: EventMessage,
  attemptOnce: (attempt: number) => Promise<"done" | "duplicate">,
  deadLetter: (error: string, attempts: number) => Promise<void>,
): Promise<"ok" | "failed"> {
  const { logger, onMetric } = deps;
  const base = deps.backoff?.baseMs ?? 100;
  const random = deps.backoff?.random ?? Math.random;
  const sleep = deps.backoff?.sleep ?? defaultSleep;
  const labels = { consumer: consumer.name };
  const ids = { consumer: consumer.name, eventId: event.id, tenantId: event.tenantId };
  let lastError: unknown;
  for (let attempt = 1; attempt <= consumer.maxAttempts; attempt++) {
    let outcome: "done" | "duplicate";
    try {
      outcome = await attemptOnce(attempt);
    } catch (err) {
      lastError = err;
      safe(() => {
        logger.warn({ ...ids, attempt, ...describeError(err) }, "consumer attempt failed");
      });
      if (attempt < consumer.maxAttempts) {
        safe(() => onMetric?.("retry", 1, labels));
        await sleep(base * 2 ** (attempt - 1) * (0.5 + random() / 2));
      }
      continue;
    }
    safe(() => onMetric?.(outcome === "done" ? "processed" : "duplicate", 1, labels));
    return "ok";
  }
  const error = truncateError(lastError);
  try {
    await deadLetter(error, consumer.maxAttempts);
  } catch (err) {
    safe(() => {
      logger.error({ ...ids, ...describeError(err) }, "dead-letter parking failed");
    });
    safe(() => onMetric?.("dead_letter_failed", 1, labels));
    return "failed";
  }
  safe(() => onMetric?.("dead_letter", 1, labels));
  safe(() => {
    logger.error({ ...ids, ...describeError(lastError) }, "event dead-lettered");
  });
  return "ok";
}
