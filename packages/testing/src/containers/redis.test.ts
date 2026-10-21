import { createConnection } from "node:net";

import { afterAll, beforeAll, expect, it } from "vitest";

import { startRedis } from "./redis.ts";

import type { RedisHarness } from "./redis.ts";

let redis: RedisHarness;
beforeAll(async () => {
  redis = await startRedis();
});
afterAll(async () => {
  await redis.stop();
});

it("answers PING", async () => {
  const { hostname, port } = new URL(redis.url);
  const reply = await new Promise<string>((resolveReply, reject) => {
    const socket = createConnection({ host: hostname, port: Number(port) }, () => {
      socket.write("PING\r\n");
    });
    socket.once("data", (d) => {
      socket.end();
      resolveReply(d.toString());
    });
    socket.once("error", reject);
  });
  expect(reply).toBe("+PONG\r\n");
});
