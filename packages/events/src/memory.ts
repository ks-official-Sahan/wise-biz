import { deliver } from "./deliver.ts";
import { ConsumerRouter } from "./router.ts";

import type { EventBus } from "./bus.ts";
import type { ConsumerContext, ConsumerDefinition } from "./consumer.ts";
import type { BackoffOptions } from "./deliver.ts";
import type { BusLogger, EventMessage, EventRef, OnMetric, PublishResult } from "./message.ts";
import type { PoolClient } from "pg";

export type DeadLetter = Readonly<{
  tenantId: string;
  consumer: string;
  eventId: string;
  error: string;
  attempts: number;
}>;

export interface MemoryBus extends EventBus {
  readonly deadLetters: readonly DeadLetter[];
}

const noClient = new Proxy({} as PoolClient, {
  get() {
    throw new Error("memory event bus has no database client");
  },
});

const silent: BusLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** In-process bus for unit tests. Same retry / idempotency / dead-letter semantics as the pg bus. */
export function createMemoryBus(
  opts: { logger?: BusLogger; backoff?: BackoffOptions; onMetric?: OnMetric } = {},
): MemoryBus {
  const logger = opts.logger ?? silent;
  const router = new ConsumerRouter();
  const processed = new Set<string>();
  const deadLetters: DeadLetter[] = [];
  let stopped = false;
  const inflight = new Set<Promise<PublishResult>>();

  async function run(event: EventMessage): Promise<boolean> {
    let ok = true;
    for (const consumer of router.match(event.type, event.version)) {
      const pk = `${event.tenantId}\u0000${consumer.name}\u0000${event.id}`;
      const r = await deliver(
        { logger, onMetric: opts.onMetric, backoff: opts.backoff },
        consumer,
        event,
        async (attempt) => {
          if (processed.has(pk)) return "duplicate";
          const ctx: ConsumerContext = { client: noClient, logger, attempt };
          await consumer.handle(event, ctx);
          processed.add(pk); // only after success, like the rolled-back pg tx
          return "done";
        },
        (error, attempts) => {
          deadLetters.push({
            tenantId: event.tenantId,
            consumer: consumer.name,
            eventId: event.id,
            error,
            attempts,
          });
          return Promise.resolve();
        },
      );
      if (r === "failed") ok = false;
    }
    return ok;
  }

  return {
    deadLetters,
    subscribe: (c: ConsumerDefinition) => {
      router.add(c);
    },
    publish: async (batch) => {
      if (stopped) throw new Error("event bus stopped");
      const p = (async (): Promise<PublishResult> => {
        const delivered: EventRef[] = [];
        const failed: EventRef[] = [];
        for (const e of batch) {
          ((await run(e)) ? delivered : failed).push({ tenantId: e.tenantId, id: e.id });
        }
        return { delivered, failed };
      })();
      inflight.add(p);
      try {
        return await p;
      } finally {
        inflight.delete(p);
      }
    },
    start: () => Promise.resolve(),
    stop: async () => {
      stopped = true;
      await Promise.allSettled([...inflight]);
    },
  };
}
