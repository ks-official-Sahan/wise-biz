import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import {
  claimOutboxBatch,
  markPublished,
  pruneOutbox,
  pruneProcessedEvents,
  quarantineExhausted,
  releaseClaims,
} from "@wise-biz/db";
import { safe } from "@wise-biz/events";

import type { OutboxKey, OutboxRow } from "@wise-biz/db";
import type { BusLogger, EventBus, EventMessage, OnMetric } from "@wise-biz/events";
import type { Pool } from "pg";

export type RelayOptions = Readonly<{
  /** Pool connected as wb_worker. */
  pool: Pool;
  bus: EventBus;
  logger: BusLogger;
  batchSize?: number;
  idleMs?: number;
  /** Claim lease; a worker that dies mid-publish loses its rows to others after this (default 300 s). */
  leaseMs?: number;
  /** Publish attempts before a row is quarantined (default 10). */
  maxAttempts?: number;
  /** Run quarantineExhausted every N loop ticks (default 20). */
  quarantineEveryTicks?: number;
  /** Maintenance (prune) interval (default 1 h). */
  maintenanceMs?: number;
  /** Retention for published outbox rows / processed_events (defaults: 7 d / 30 d). */
  retention?: Readonly<{ outboxMs?: number; processedMs?: number }>;
  workerId?: string;
  onMetric?: OnMetric | undefined;
}>;

export interface Relay {
  /** One claim -> publish -> mark cycle. Returns rows claimed. Throws if publish failed (rows are released). */
  tick(): Promise<number>;
  /** Quarantine rows that exhausted maxAttempts. Returns how many. Never throws. */
  quarantine(): Promise<number>;
  /** Prune old published outbox / processed_events rows. Never throws. */
  maintain(): Promise<void>;
  /** Start the loop (idempotent). */
  start(): void;
  /** Stop the loop; resolves after the in-flight batch finishes. Backoff sleeps are aborted. */
  stop(): Promise<void>;
}

const MAX_ERROR_BACKOFF_MS = 10_000;
const HOUR = 3_600_000;
const MAX_LOGGED_IDS = 50;

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

const keyOf = (r: OutboxKey): OutboxKey => ({ tenantId: r.tenantId, id: r.id });

/**
 * Outbox relay, lease model. Loop: claim (one short auto-commit statement, sets a lease and counts the
 * attempt) -> bus.publish with NO database transaction open -> markPublished for delivered events,
 * releaseClaims for failed ones. A crash mid-publish just lets the lease expire; the rows are redelivered
 * and consumers dedupe on processed_events. Rows that used all attempts are quarantined (logged, not retried).
 */
export function createRelay(opts: RelayOptions): Relay {
  const { pool, bus, logger, onMetric } = opts;
  const batchSize = opts.batchSize ?? 500;
  const idleMs = opts.idleMs ?? 250;
  const leaseMs = opts.leaseMs ?? 300_000;
  const maxAttempts = opts.maxAttempts ?? 10;
  const quarantineEvery = opts.quarantineEveryTicks ?? 20;
  const maintenanceMs = opts.maintenanceMs ?? HOUR;
  const workerId =
    opts.workerId ?? `${hostname()}-${String(process.pid)}-${randomBytes(4).toString("hex")}`;

  let stopping = false;
  let loop: Promise<void> | undefined;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let maintaining: Promise<void> | undefined;
  const wakers = new Set<() => void>();

  const metric = (name: Parameters<OnMetric>[0], value = 1): void => {
    safe(() => onMetric?.(name, value, {}));
  };
  const logError = (obj: object, msg: string): void => {
    safe(() => {
      logger.error(obj, msg);
    });
  };

  /** Abortable: resolves after `ms` or as soon as stop() is called. */
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopping) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(t);
        wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      wakers.add(done);
    });

  async function release(rows: readonly OutboxKey[]): Promise<void> {
    try {
      await releaseClaims(pool, rows.map(keyOf), workerId);
    } catch (err) {
      // lease expiry still frees the rows; just say so
      logError({ err, workerId, count: rows.length }, "relay releaseClaims failed");
    }
  }

  async function tick(): Promise<number> {
    let rows: OutboxRow[];
    try {
      rows = await claimOutboxBatch(pool, { limit: batchSize, leaseMs, maxAttempts, workerId });
    } catch (err) {
      metric("relay_error");
      throw err;
    }
    if (rows.length === 0) return 0;
    let result;
    try {
      result = await bus.publish(rows.map(toMessage)); // no DB transaction is open here
    } catch (err) {
      metric("relay_error");
      await release(rows);
      throw err;
    }
    const delivered = result.delivered;
    if (delivered.length > 0) {
      // if this fails the lease expires and the batch is redelivered (consumers dedupe)
      await markPublished(pool, delivered.map(keyOf), workerId);
    }
    if (result.failed.length > 0) {
      await release(result.failed);
      metric("relay_error", result.failed.length);
      throw new Error(`${String(result.failed.length)} event(s) failed to deliver`);
    }
    const first = rows[0];
    if (first) {
      metric("relay_batch", rows.length);
      metric("relay_lag_ms", Math.max(0, Date.now() - first.createdAt.getTime()));
    }
    return rows.length;
  }

  async function quarantine(): Promise<number> {
    try {
      const keys = await quarantineExhausted(pool, { maxAttempts });
      if (keys.length === 0) return 0;
      const byTenant = new Map<string, string[]>();
      for (const k of keys) {
        const ids = byTenant.get(k.tenantId);
        if (ids) ids.push(k.id);
        else byTenant.set(k.tenantId, [k.id]);
      }
      for (const [tenantId, ids] of byTenant) {
        safe(() => {
          logger.warn(
            { tenantId, count: ids.length, eventIds: ids.slice(0, MAX_LOGGED_IDS), maxAttempts },
            "outbox events quarantined after max attempts",
          );
        });
      }
      metric("relay_quarantined", keys.length);
      return keys.length;
    } catch (err) {
      metric("relay_maintenance_error");
      logError({ err, task: "quarantine" }, "relay quarantine failed");
      return 0;
    }
  }

  function maintain(): Promise<void> {
    maintaining ??= (async () => {
      try {
        const o = await pruneOutbox(pool, {
          ...(opts.retention?.outboxMs !== undefined && { olderThanMs: opts.retention.outboxMs }),
        });
        metric("relay_pruned_outbox", o);
        const p = await pruneProcessedEvents(pool, {
          ...(opts.retention?.processedMs !== undefined && {
            olderThanMs: opts.retention.processedMs,
          }),
        });
        metric("relay_pruned_processed", p);
      } catch (err) {
        metric("relay_maintenance_error");
        logError({ err, task: "prune" }, "relay maintenance failed");
      } finally {
        maintaining = undefined;
      }
    })();
    return maintaining;
  }

  function scheduleMaintenance(): void {
    maintenanceTimer = setTimeout(() => {
      void maintain().finally(() => {
        if (!stopping) scheduleMaintenance();
      });
    }, maintenanceMs);
    maintenanceTimer.unref();
  }

  async function run(): Promise<void> {
    let failures = 0;
    let ticks = 0;
    while (!stopping) {
      try {
        const n = await tick();
        failures = 0;
        ticks++;
        if (ticks % quarantineEvery === 0) await quarantine();
        if (n === 0) await sleep(idleMs);
      } catch (err) {
        failures++;
        metric("relay_loop_error");
        logError({ err, failures }, "relay tick failed");
        await sleep(Math.min(idleMs * 2 ** Math.min(failures, 16), MAX_ERROR_BACKOFF_MS));
      }
    }
  }

  return {
    tick,
    quarantine,
    maintain,
    start: () => {
      if (loop) return;
      stopping = false;
      loop = run().catch((err: unknown) => {
        logError({ err }, "relay loop crashed"); // run() catches everything; belt and braces
      });
      scheduleMaintenance();
    },
    stop: async () => {
      stopping = true;
      clearTimeout(maintenanceTimer);
      for (const wake of [...wakers]) wake();
      await loop;
      await maintaining;
      loop = undefined;
    },
  };
}
