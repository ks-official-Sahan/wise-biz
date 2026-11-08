import { createHmac, timingSafeEqual } from "node:crypto";

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
  name: "idempotency_cache_error" | "idempotency_cache_forged",
  value: number,
  labels: Readonly<Record<string, string>>,
) => void;

export interface CacheOptions {
  onMetric?: CacheOnMetric | undefined;
  /** Per-command deadline; a hung socket must not delay requests. Default 200 ms. */
  timeoutMs?: number;
  /**
   * Secret that signs every stored value (HMAC-SHA256 over key + value). A value written by anyone who does not hold it
   * (a Redis writer, a misrouted client) is treated as a miss, so Postgres decides. Rotating it only costs cache hits.
   */
  macKey?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 200;
const MAC_LABEL = "wise-biz/idempotency-cache/v1";
const MAC_HEX = 64;

const macOf = (derived: Buffer, key: string, value: string): string =>
  createHmac("sha256", derived).update(key).update("\n").update(value).digest("hex");

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
  // A separate key per purpose, so the session secret itself never signs anything else.
  const derived =
    opts.macKey === undefined || opts.macKey === ""
      ? undefined
      : createHmac("sha256", opts.macKey).update(MAC_LABEL).digest();
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
        const raw = await withTimeout(redis.get(key), timeoutMs);
        if (derived === undefined || raw === null) return raw;
        // "<hex mac>.<value>": anything else, or a mac that does not match, is a forged or foreign entry.
        const mac = raw.slice(0, MAC_HEX);
        const value = raw.slice(MAC_HEX + 1);
        const expected = macOf(derived, key, value);
        if (
          raw[MAC_HEX] === "." &&
          mac.length === MAC_HEX &&
          timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
        ) {
          return value;
        }
        try {
          opts.onMetric?.("idempotency_cache_forged", 1, {});
        } catch {
          // a metrics sink must never fail a request
        }
        return null;
      } catch (err) {
        fail("get", err);
        return null;
      }
    },
    async set(key, value, ttlMs) {
      try {
        await withTimeout(
          redis.set(key, derived === undefined ? value : `${macOf(derived, key, value)}.${value}`, {
            expiration: { type: "PX", value: ttlMs },
          }),
          timeoutMs,
        );
      } catch (err) {
        fail("set", err);
      }
    },
  };
}
