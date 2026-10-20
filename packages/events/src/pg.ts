import { recordDeadLetter, recordProcessed } from "@wise-biz/db";

import { deliver } from "./deliver.ts";
import { ConsumerRouter } from "./router.ts";

import type { EventBus } from "./bus.ts";
import type { ConsumerDefinition } from "./consumer.ts";
import type { BackoffOptions } from "./deliver.ts";
import type { BusLogger, EventMessage, OnMetric } from "./message.ts";
import type { Pool } from "pg";

export type PgBusOptions = Readonly<{
  /** Pool connected as wb_worker. */
  pool: Pool;
  logger: BusLogger;
  backoff?: BackoffOptions;
  onMetric?: OnMetric | undefined;
}>;

/**
 * Postgres bus. publish() delivers synchronously to every matching consumer; each (event, consumer)
 * pair runs in its own transaction: recordProcessed + handler commit or roll back together, so a
 * failed handler leaves no processed row and a redelivery is a no-op once it has succeeded.
 * Events in a batch are handled in order (per-key ordering); consumers are independent of each other.
 */
export function createPgBus(opts: PgBusOptions): EventBus {
  const { pool, logger } = opts;
  const router = new ConsumerRouter();
  const inflight = new Set<Promise<void>>();
  let stopped = false;

  async function attemptOnce(
    consumer: ConsumerDefinition,
    event: EventMessage,
    attempt: number,
  ): Promise<"done" | "duplicate"> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      try {
        const first = await recordProcessed(client, {
          tenantId: event.tenantId,
          consumer: consumer.name,
          eventId: event.id,
        });
        if (first) await consumer.handle(event, { client, logger, attempt });
        await client.query("COMMIT");
        return first ? "done" : "duplicate";
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rbErr) {
          broken = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        }
        throw err;
      }
    } finally {
      client.release(broken); // truthy arg destroys a connection in an unknown state
    }
  }

  async function parkDeadLetter(
    consumer: ConsumerDefinition,
    event: EventMessage,
    error: string,
    attempts: number,
  ): Promise<void> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      try {
        await recordDeadLetter(client, {
          tenantId: event.tenantId,
          consumer: consumer.name,
          eventId: event.id,
          error,
          attempts,
          payload: event.payload,
        });
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch (rbErr) {
          broken = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
        }
        throw err;
      }
    } finally {
      client.release(broken);
    }
  }

  async function run(batch: readonly EventMessage[]): Promise<void> {
    const deps = { logger, onMetric: opts.onMetric, backoff: opts.backoff };
    for (const event of batch) {
      for (const consumer of router.match(event.type, event.version)) {
        await deliver(
          deps,
          consumer,
          event,
          (attempt) => attemptOnce(consumer, event, attempt),
          (error, attempts) => parkDeadLetter(consumer, event, error, attempts),
        );
      }
    }
  }

  return {
    subscribe: (c) => {
      router.add(c);
    },
    publish: async (batch) => {
      if (stopped) throw new Error("event bus stopped");
      const p = run(batch);
      inflight.add(p);
      try {
        await p;
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
