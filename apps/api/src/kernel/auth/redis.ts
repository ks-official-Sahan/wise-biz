import type { KernelRedis } from "./types.ts";

interface Multi {
  incr(key: string): Multi;
  pExpire(key: string, ms: number, mode: "NX"): Multi;
  pTTL(key: string): Multi;
  exec(): Promise<unknown[]>;
}

/** Structural slice of the node-redis client (tests can pass a fake). */
export interface NodeRedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { expiration: { type: "EX"; value: number }; condition?: "NX" },
  ): Promise<unknown>;
  multi(): Multi;
}

export function nodeRedisKernel(client: NodeRedisLike): KernelRedis {
  return {
    get: (key) => client.get(key),
    async set(key, value, ttlSeconds) {
      await client.set(key, value, { expiration: { type: "EX", value: ttlSeconds } });
    },
    async claim(key, ttlSeconds) {
      const reply = await client.set(key, "1", {
        expiration: { type: "EX", value: ttlSeconds },
        condition: "NX",
      });
      return reply === "OK";
    },
    async hit(key, windowMs) {
      const reply = await client.multi().incr(key).pExpire(key, windowMs, "NX").pTTL(key).exec();
      const count = reply[0];
      const ttl = reply[2];
      if (typeof count !== "number" || typeof ttl !== "number") {
        throw new Error("unexpected MULTI reply");
      }
      return { count, ttlMs: ttl > 0 ? ttl : windowMs };
    },
  };
}
