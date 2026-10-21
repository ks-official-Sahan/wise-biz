import { RedisContainer } from "@testcontainers/redis";

export const REDIS_IMAGE = "redis:8.10.2-alpine";

export interface RedisHarness {
  url: string;
  stop(): Promise<void>;
}

export async function startRedis(): Promise<RedisHarness> {
  const container = await new RedisContainer(REDIS_IMAGE).start();
  return {
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
}
