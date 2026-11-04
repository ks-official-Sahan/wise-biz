import { DomainError } from "@wise-biz/errors";

import type { KernelRedis } from "../auth/types.ts";
import type { NonceStore } from "@wise-biz/http-signatures";

/**
 * Device-signature nonces in Redis (`SET dn:{device}:{nonce} 1 NX EX ttl`). FAIL CLOSED like the rate limiter: with
 * Redis absent or down a signed request is refused (503), never accepted without replay protection.
 */
export function deviceNonces(redis: KernelRedis | undefined): NonceStore {
  return {
    async claim(key, ttlSeconds) {
      if (redis === undefined) {
        throw new DomainError("RATE_LIMIT_UNAVAILABLE", "Replay protection unavailable");
      }
      try {
        return await redis.claim(`dn:${key}`, ttlSeconds);
      } catch (cause) {
        throw new DomainError("RATE_LIMIT_UNAVAILABLE", "Replay protection unavailable", { cause });
      }
    },
  };
}
