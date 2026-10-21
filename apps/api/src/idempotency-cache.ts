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

/**
 * Redis-backed cache of completed idempotent responses. Best effort by design: with the client's
 * disableOfflineQueue an unreachable Redis rejects immediately; every error is logged (rate-limited by
 * `errors` counter below) and swallowed so the request falls through to Postgres, which stays correct.
 */
export function redisIdempotencyCache(
  redis: RedisKv,
  logger: Logger,
): IdempotencyCache & { readonly errors: () => number } {
  let errors = 0;
  const fail = (op: string, err: unknown): void => {
    errors += 1;
    // Log the first error and then every 100th so an outage cannot flood the log.
    if (errors === 1 || errors % 100 === 0) {
      logger.warn({ err, op, errors }, "idempotency cache unavailable; falling back to postgres");
    }
  };
  return {
    errors: () => errors,
    async get(key) {
      try {
        return await redis.get(key);
      } catch (err) {
        fail("get", err);
        return null;
      }
    },
    async set(key, value, ttlMs) {
      try {
        await redis.set(key, value, { expiration: { type: "PX", value: ttlMs } });
      } catch (err) {
        fail("set", err);
      }
    },
  };
}
