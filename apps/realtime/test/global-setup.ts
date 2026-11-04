import { startRedis } from "@wise-biz/testing/containers";

import type { RedisHarness } from "@wise-biz/testing/containers";

let redis: RedisHarness | undefined;

/**
 * The server and start tests need a real Redis. Use TEST_REDIS_URL when it is set (a dev's local Redis); otherwise start a
 * throwaway container, so CI and a fresh checkout need nothing installed.
 */
export async function setup(): Promise<void> {
  if (process.env.TEST_REDIS_URL !== undefined) return;
  redis = await startRedis();
  process.env.TEST_REDIS_URL = redis.url;
}

export async function teardown(): Promise<void> {
  await redis?.stop();
}
