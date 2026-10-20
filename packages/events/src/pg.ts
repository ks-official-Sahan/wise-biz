import { recordDeadLetter, recordProcessed } from "@wise-biz/db";

import { deliver, describeError, safe } from "./deliver.ts";
import { ConsumerRouter } from "./router.ts";

import type { EventBus } from "./bus.ts";
import type { BackoffOptions } from "./deliver.ts";
import type { BusLogger, EventMessage, EventRef, OnMetric, PublishResult } from "./message.ts";
import type { Pool, PoolClient } from "pg";

export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

export type PgBusOptions = Readonly<{
  /** Pool connected as wb_worker. */
  pool: Pool;
  logger: BusLogger;
  backoff?: BackoffOptions;
  onMetric?: OnMetric | undefined;
  /** Per (event, consumer) attempt: statement_timeout + hard timer (default 30 s). */
  handlerTimeoutMs?: number;
}>;

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Postgres bus. publish() delivers synchronously to every matching consumer; each (event, consumer)
 * pair runs in its own transaction: recordProcessed + handler commit or roll back together, so a
 * failed handler leaves no processed row and a redelivery is a no-op once it has succeeded.
 * Events in a batch are handled in order (per-key ordering); consumers are independent of each other.
 *
 * Security model: consumers connect as wb_worker (cross-tenant by explicit policies on infra.*), but
 * every consumer tx starts with `set_config('app.tenant_id', <event tenant>, true)` and
 * `app.request_id = <event id>`, so RLS-scoped writes done by a handler are tenant-scoped like an API request.
 */
export function createPgBus(opts: PgBusOptions): EventBus {
  const { pool, logger } = opts;
  const timeoutMs = opts.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("createPgBus: handlerTimeoutMs must be an integer >= 1");
  const router = new ConsumerRouter();
  const inflight = new Set<Promise<PublishResult>>();
  let stopped = false;

  /**
   * BEGIN -> tenant scope + statement_timeout -> body -> COMMIT (verified). On any failure the tx is rolled
   * back; if that is impossible (rollback fails, or the body timed out and may still hold the connection)
   * the client is destroyed via release(err) so a busy/unknown connection never returns to the pool.
   */
  async function inTx<T>(
    event: EventMessage,
    body: (client: PoolClient) => Promise<T>,
    limitMs?: number,
  ): Promise<T> {
    const client = await pool.connect();
    let broken: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      await client.query("BEGIN");
      try {
        await client.query(
          "select set_config('app.tenant_id', $1, true), set_config('app.request_id', $2, true), set_config('statement_timeout', $3, true)",
          [event.tenantId, event.id, String(limitMs ?? 0)],
        );
        let work = body(client);
        if (limitMs !== undefined) {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              broken = new Error(`handler timed out after ${String(limitMs)} ms`);
              reject(broken);
            }, limitMs);
          });
          work.catch(() => undefined); // a late rejection after the race is settled must not be unhandled
          work = Promise.race([work, timeout]);
        }
        const result = await work;
        if (timer) clearTimeout(timer);
        const done = await client.query("COMMIT");
        // An aborted tx (handler swallowed a SQL error) answers COMMIT with the ROLLBACK tag.
        if (done.command !== "COMMIT") throw new Error("transaction aborted: commit rolled back");
        return result;
      } catch (err) {
        if (broken === undefined) {
          try {
            await client.query("ROLLBACK");
          } catch (rbErr) {
            broken = toError(rbErr);
            safe(() => {
              logger.error(
                { tenantId: event.tenantId, eventId: event.id, ...describeError(rbErr) },
                "rollback failed; connection destroyed",
              );
            });
          }
        }
        throw err;
      }
    } finally {
      if (timer) clearTimeout(timer);
      client.release(broken); // truthy arg destroys a connection in an unknown state
    }
  }

  async function run(batch: readonly EventMessage[]): Promise<PublishResult> {
    const deps = { logger, onMetric: opts.onMetric, backoff: opts.backoff };
    const delivered: EventRef[] = [];
    const failed: EventRef[] = [];
    for (const event of batch) {
      let ok = true;
      for (const consumer of router.match(event.type, event.version)) {
        const r = await deliver(
          deps,
          consumer,
          event,
          (attempt) =>
            inTx(
              event,
              async (client) => {
                const first = await recordProcessed(client, {
                  tenantId: event.tenantId,
                  consumer: consumer.name,
                  eventId: event.id,
                });
                if (!first) return "duplicate" as const;
                await consumer.handle(event, { client, logger, attempt });
                return "done" as const;
              },
              timeoutMs,
            ),
          (error, attempts) =>
            inTx(
              event,
              async (client) => {
                await recordDeadLetter(client, {
                  tenantId: event.tenantId,
                  consumer: consumer.name,
                  eventId: event.id,
                  error,
                  attempts,
                  payload: event.payload,
                });
              },
              timeoutMs,
            ),
        );
        if (r === "failed") ok = false;
      }
      (ok ? delivered : failed).push({ tenantId: event.tenantId, id: event.id });
    }
    return { delivered, failed };
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
