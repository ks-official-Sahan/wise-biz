import type { IdempotencyCache } from "@wise-biz/module-kit";
import type { Logger } from "pino";

/** The slice of the node-redis client the cache needs (structural, so tests can pass a fake). */
export interface RedisKv {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { expiration: { type: "PX"; value: number } },
  ): Promise<unknown>;
}

/** Metrics hook (same shape as the audit/event hooks); a no-op when absent. */
export type CacheOnMetric = (
  name: "idempotency_cache_error",
  value: number,
  labels: Readonly<Record<string, string>>,
) => void;

export interface CacheOptions {
  onMetric?: CacheOnMetric | undefined;
  /** Per-command deadline; a hung socket must not delay requests. Default 200 ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 200;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`redis command timed out after ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Redis-backed cache of completed idempotent responses. Best effort by design: with the client's
 * disableOfflineQueue an unreachable Redis rejects immediately; every error is logged (rate-limited by
 * `errors` counter below, also exported through `onMetric`) and swallowed so the request falls through to Postgres, which stays correct.
 */
export function redisIdempotencyCache(
  redis: RedisKv,
  logger: Logger,
  opts: CacheOptions = {},
): IdempotencyCache & { readonly errors: () => number } {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let errors = 0;
  const fail = (op: string, err: unknown): void => {
    errors += 1;
    try {
      opts.onMetric?.("idempotency_cache_error", 1, { op });
    } catch {
      // a metrics sink must never fail a request
    }
    // Log the first error and then every 100th so an outage cannot flood the log.
    if (errors === 1 || errors % 100 === 0) {
      logger.warn({ err, op, errors }, "idempotency cache unavailable; falling back to postgres");
    }
  };
  return {
    errors: () => errors,
    async get(key) {
      try {
        return await withTimeout(redis.get(key), timeoutMs);
      } catch (err) {
        fail("get", err);
        return null;
      }
    },
    async set(key, value, ttlMs) {
      try {
        await withTimeout(
          redis.set(key, value, { expiration: { type: "PX", value: ttlMs } }),
          timeoutMs,
        );
      } catch (err) {
        fail("set", err);
      }
    },
  };
}
