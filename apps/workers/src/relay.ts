import { bumpAttempts, claimOutboxBatch, markPublished } from "@wise-biz/db";

import type { OutboxRow } from "@wise-biz/db";
import type { BusLogger, EventBus, EventMessage, OnMetric } from "@wise-biz/events";
import type { Pool, PoolClient } from "pg";

export type RelayOptions = Readonly<{
  /** Pool connected as wb_worker. */
  pool: Pool;
  bus: EventBus;
  logger: BusLogger;
  batchSize?: number;
  idleMs?: number;
  onMetric?: OnMetric | undefined;
}>;

export interface Relay {
  /** One claim -> publish -> mark cycle. Returns rows relayed. Throws on failure (rows stay unpublished). */
  tick(): Promise<number>;
  /** Start the loop (idempotent). */
  start(): void;
  /** Stop the loop; resolves after the in-flight batch finishes. */
  stop(): Promise<void>;
}

const MAX_ERROR_BACKOFF_MS = 10_000;

export const toMessage = (r: OutboxRow): EventMessage => ({
  id: r.id,
  tenantId: r.tenantId,
  topic: r.topic,
  key: r.key,
  type: r.type,
  version: r.version,
  payload: r.payload,
  headers: r.headers,
  createdAt: r.createdAt,
});

/**
 * Outbox relay. Failure policy: if publish throws, ROLLBACK (rows stay unpublished and are retried on the
 * next tick), then best-effort bump `attempts` in a separate short tx so poison batches are visible, record
 * `relay_error` and back off exponentially (idleMs x2 per consecutive failure, max 10 s) to avoid a hot loop.
 * Re-delivery after a partial publish is safe: consumers dedupe on processed_events.
 * Keep batchSize x worst-case handler time under the role's idle_in_transaction_session_timeout (60 s).
 */
export function createRelay(opts: RelayOptions): Relay {
  const { pool, bus, logger, onMetric } = opts;
  const batchSize = opts.batchSize ?? 500;
  const idleMs = opts.idleMs ?? 250;

  let stopping = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  async function rollback(client: PoolClient): Promise<Error | undefined> {
    try {
      await client.query("ROLLBACK");
      return undefined;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }

  async function noteFailure(rows: readonly OutboxRow[]): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await bumpAttempts(
        client,
        rows.map((r) => ({ tenantId: r.tenantId, id: r.id })),
      );
      await client.query("COMMIT");
    } catch {
      await rollback(client);
    } finally {
      client.release();
    }
  }

  async function tick(): Promise<number> {
    const client = await pool.connect();
    let broken: Error | undefined;
    let rows: OutboxRow[] = [];
    let failure: { err: unknown } | undefined;
    try {
      await client.query("BEGIN");
      rows = await claimOutboxBatch(client, { limit: batchSize });
      if (rows.length > 0) {
        await bus.publish(rows.map(toMessage));
        await markPublished(
          client,
          rows.map((r) => ({ tenantId: r.tenantId, id: r.id })),
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      broken = await rollback(client);
      failure = { err };
    } finally {
      client.release(broken); // truthy arg destroys a connection in an unknown state
    }
    if (failure) {
      onMetric?.("relay_error", 1, {});
      if (rows.length > 0) await noteFailure(rows);
      throw failure.err;
    }
    const first = rows[0];
    if (first) {
      onMetric?.("relay_batch", rows.length, {});
      onMetric?.("relay_lag_ms", Math.max(0, Date.now() - first.createdAt.getTime()), {});
    }
    return rows.length;
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  async function run(): Promise<void> {
    let failures = 0;
    while (!stopping) {
      try {
        const n = await tick();
        failures = 0;
        if (n === 0) await sleep(idleMs);
      } catch (err) {
        failures++;
        logger.error({ err, failures }, "relay tick failed");
        await sleep(Math.min(idleMs * 2 ** Math.min(failures, 16), MAX_ERROR_BACKOFF_MS));
      }
    }
  }

  return {
    tick,
    start: () => {
      if (loop) return;
      stopping = false;
      loop = run();
    },
    stop: async () => {
      stopping = true;
      wake?.();
      await loop;
      loop = undefined;
    },
  };
}
