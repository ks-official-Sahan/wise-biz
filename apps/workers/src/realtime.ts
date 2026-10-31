import { redisChannel } from "@wise-biz/module-sync";
import { createClient } from "redis";

import type { ChangeNotice } from "@wise-biz/module-sync";
import type { Logger } from "pino";

/** The one thing the consumers need: a fire-and-forget hint. */
export interface RealtimePublisher {
  notify: (notice: ChangeNotice) => void;
  stop: () => Promise<void>;
}

/** Minimal publish surface of the redis client (tests pass a fake). */
export interface PublishClient {
  publish: (channel: string, message: string) => Promise<unknown>;
}

/**
 * Hints go to Redis pub/sub `rt:{tenantId}:{channel}` (events.md, Realtime fan-out). Publishing never throws into the
 * consumer and never queues while Redis is down (offline queue off): a lost hint costs the terminal one poll interval.
 */
export function publisherFor(client: PublishClient, logger: Logger): RealtimePublisher["notify"] {
  return (n) => {
    client
      .publish(redisChannel(n.tenantId, n.channel), JSON.stringify({ dataset: n.dataset }))
      .catch((err: unknown) => {
        logger.warn({ err, channel: n.channel }, "realtime hint not published");
      });
  };
}

export function createRealtimePublisher(
  url: string | undefined,
  logger: Logger,
): RealtimePublisher {
  if (url === undefined) return { notify: () => undefined, stop: () => Promise.resolve() };
  const client = createClient({
    url,
    socket: { connectTimeout: 2000, reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
    disableOfflineQueue: true,
  });
  client.on("error", (err: unknown) => {
    logger.warn({ err }, "realtime redis error");
  });
  client.connect().catch((err: unknown) => {
    logger.warn({ err }, "realtime redis not connected; hints off until it reconnects");
  });
  return {
    notify: publisherFor(client, logger),
    stop: async () => {
      if (client.isOpen) await client.close();
    },
  };
}
