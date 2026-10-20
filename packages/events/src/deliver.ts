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

export const truncateError = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_CHARS);

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type DeliverDeps = Readonly<{
  logger: BusLogger;
  onMetric?: OnMetric | undefined;
  backoff?: BackoffOptions | undefined;
}>;

/**
 * Run `attemptOnce` up to consumer.maxAttempts with exponential backoff.
 * `attemptOnce` returns "done" | "duplicate" or throws. After the last failure `deadLetter` is called
 * (its own failure propagates: better to retry the whole batch than lose the event).
 */
export async function deliver(
  deps: DeliverDeps,
  consumer: ConsumerDefinition,
  event: EventMessage,
  attemptOnce: (attempt: number) => Promise<"done" | "duplicate">,
  deadLetter: (error: string, attempts: number) => Promise<void>,
): Promise<void> {
  const { logger, onMetric } = deps;
  const base = deps.backoff?.baseMs ?? 100;
  const random = deps.backoff?.random ?? Math.random;
  const sleep = deps.backoff?.sleep ?? defaultSleep;
  const labels = { consumer: consumer.name };
  let lastError: unknown;
  for (let attempt = 1; attempt <= consumer.maxAttempts; attempt++) {
    try {
      const outcome = await attemptOnce(attempt);
      onMetric?.(outcome === "done" ? "processed" : "duplicate", 1, labels);
      return;
    } catch (err) {
      lastError = err;
      logger.warn(
        { consumer: consumer.name, eventId: event.id, tenantId: event.tenantId, attempt },
        "consumer attempt failed",
      );
      if (attempt < consumer.maxAttempts) {
        onMetric?.("retry", 1, labels);
        await sleep(base * 2 ** (attempt - 1) * (0.5 + random() / 2));
      }
    }
  }
  const error = truncateError(lastError);
  await deadLetter(error, consumer.maxAttempts);
  onMetric?.("dead_letter", 1, labels);
  logger.error(
    { consumer: consumer.name, eventId: event.id, tenantId: event.tenantId, error },
    "event dead-lettered",
  );
}
