import { createHintStream } from "./hints.ts";
import { createIndexes } from "./indexes.ts";
import { createOutbox } from "./outbox.ts";
import { createPullLoop } from "./pull.ts";
import { createPushLoop } from "./push.ts";

import type { OnClientMetric, Timers } from "./backoff.ts";
import type { Hint, HintState, OpenStream, StreamTicket } from "./hints.ts";
import type { KeyStore, OutboxTx } from "./outbox.ts";
import type { Dataset, Gunzip, PullEvent, PullTransport } from "./pull.ts";
import type { LoopEvent, LoopState, Transport } from "./push.ts";
import type { LocalDb } from "./storage/local-db.ts";
import type { Hlc } from "@wise-biz/ids";

export interface SyncClientDeps {
  db: LocalDb;
  keys: KeyStore;
  hlc: Hlc;
  ids: { uuidv7: () => string };
  push: Transport;
  pull: PullTransport;
  gunzip: Gunzip;
  datasets: readonly Dataset[];
  /** Realtime hints; omit to rely on the poll alone. */
  realtime?: { ticket: () => Promise<StreamTicket>; open: OpenStream };
  onPushEvent?: (e: LoopEvent) => void;
  onPullEvent?: (e: PullEvent) => void;
  onHintState?: (s: HintState) => void;
  /** Background failures nobody awaits (storage closed, a bad row): report them, never crash the app. */
  onError?: (err: unknown) => void;
  /** Timings and counts for the host's logger or telemetry. */
  onMetric?: OnClientMetric;
  pollMs?: number;
  yieldToUi?: () => Promise<void>;
  now?: () => number;
  timers?: Timers;
  random?: () => number;
}

export interface SyncHealth {
  readonly unsyncedCount: number;
  readonly oldestUnsyncedAt: number | undefined;
  /** How long the oldest unsynced command has waited. */
  readonly lagMs: number;
  readonly push: LoopState;
  /** Datasets still waiting for their first snapshot (show "first sync" in the UI). */
  readonly pendingBootstrap: readonly Dataset[];
}

/**
 * The device's sync: local database + outbox + push loop + pull loop + hint stream + in-memory indexes, wired the way
 * the sell screen needs them. The UI writes through `transaction` (domain rows and the signed command in one commit),
 * which also nudges the push loop; everything else runs in the background and never blocks a sale.
 */
export function createSyncClient(deps: SyncClientDeps) {
  const now = deps.now ?? Date.now;
  const outbox = createOutbox({
    db: deps.db,
    keys: deps.keys,
    hlc: deps.hlc,
    ids: deps.ids,
    now,
  });
  const indexes = createIndexes(deps.db);
  const metric: OnClientMetric = (n, v, l) => deps.onMetric?.(n, v, l);
  const report = (err: unknown): void => {
    deps.onError?.(err);
  };
  const common = {
    ...(deps.timers ? { timers: deps.timers } : {}),
    ...(deps.random ? { random: deps.random } : {}),
    ...(deps.yieldToUi ? { yieldToUi: deps.yieldToUi } : {}),
  };

  const pushLoop = createPushLoop({
    outbox,
    transport: deps.push,
    onMetric: metric,
    onEvent: (e) => {
      deps.onPushEvent?.(e);
      if (e.type === "pushed") metric("unsynced_count", e.remaining, {});
    },
    ...common,
  });
  const pullLoop = createPullLoop({
    db: deps.db,
    transport: deps.pull,
    gunzip: deps.gunzip,
    datasets: deps.datasets,
    onChanges: (d, c) => {
      indexes.apply(d, c);
    },
    onReset: (d) => {
      if (d === "catalog") indexes.load().catch(report);
    },
    onMetric: metric,
    ...(deps.onPullEvent ? { onEvent: deps.onPullEvent } : {}),
    ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
    now,
    ...common,
  });
  const hints = deps.realtime
    ? createHintStream({
        ticket: deps.realtime.ticket,
        open: deps.realtime.open,
        onReady: () => {
          pullLoop.request().catch(report);
        },
        onHints: (hs: readonly Hint[]) => {
          pullLoop.hint([...new Set(hs.map((h) => h.dataset))]).catch(report);
        },
        ...(deps.onHintState ? { onState: deps.onHintState } : {}),
        ...common,
      })
    : undefined;

  return {
    outbox,
    indexes,
    pushLoop,
    pullLoop,
    /** Local write: domain rows and the signed command commit together, then the push loop is nudged. */
    async transaction<T>(fn: (tx: OutboxTx) => Promise<T>): Promise<T> {
      const out = await outbox.transaction(fn);
      pushLoop.trigger().catch(report);
      return out;
    },
    async start(): Promise<void> {
      await indexes.load();
      pushLoop.start();
      pushLoop.trigger().catch(report);
      hints?.start();
      await pullLoop.start();
    },
    /** The network came back. */
    nudge(): void {
      pushLoop.networkUp().catch(report);
      pullLoop.networkUp().catch(report);
    },
    /** After a fresh sign-in or an owner's re-enrolment. */
    resume(): void {
      pushLoop.resume().catch(report);
      hints?.resume();
      pullLoop.request().catch(report);
    },
    async health(): Promise<SyncHealth> {
      const oldest = await outbox.oldestUnsyncedAt();
      const lagMs = oldest === undefined ? 0 : Math.max(0, now() - oldest);
      metric("sync_lag_ms", lagMs, {});
      return {
        unsyncedCount: await outbox.unsyncedCount(),
        oldestUnsyncedAt: oldest,
        lagMs,
        push: pushLoop.state(),
        pendingBootstrap: await pullLoop.pendingBootstrap(),
      };
    },
    async stop(): Promise<void> {
      await Promise.all([pushLoop.stop(), pullLoop.stop(), hints?.stop()]);
    },
  };
}

export type SyncClient = ReturnType<typeof createSyncClient>;
