import { fromUtf8 } from "@wise-biz/crypto";

import { backoffDelay, createSleeper, defaultTimers } from "./backoff.ts";
import { TransportError } from "./push.ts";

import type { OnClientMetric, Timers } from "./backoff.ts";
import type { LocalDb, Tx } from "./storage/local-db.ts";

/** Datasets the server feeds (modules/sync). A host pulls the ones it uses. */
export type Dataset =
  | "catalog"
  | "prices"
  | "tax"
  | "promotions"
  | "stock_branch"
  | "customers_recent"
  | "policy_snapshot"
  | "entitlements"
  | "theme"
  | "receipt_template";

export interface PullChange {
  readonly entity: string;
  readonly entityId: string;
  readonly op: "upsert" | "delete";
  readonly version: number;
  readonly payload: unknown;
  readonly changedAt: string;
}

export interface ChangesPage {
  readonly changes: readonly PullChange[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface BootstrapInfo {
  /** Continue with `changes` from here after loading the snapshot. */
  readonly cursor: string | null;
  /** Null when the dataset is empty. */
  readonly url: string | null;
}

/**
 * The network edge for pulling (signed requests, ETag handling, built in P1-08). `changes` answers `"not_modified"`
 * for a 304: nothing new, no body to parse.
 */
export interface PullTransport {
  changes: (
    dataset: Dataset,
    cursor: string | undefined,
    limit: number,
  ) => Promise<ChangesPage | "not_modified">;
  bootstrap: (dataset: Dataset) => Promise<BootstrapInfo>;
  /** The snapshot file as downloaded (gzip). */
  download: (url: string) => Promise<Uint8Array>;
}

/** gzip -> bytes. Node: zlib; web: DecompressionStream; React Native: fflate/pako. Injected, never assumed. */
export type Gunzip = (bytes: Uint8Array) => Promise<Uint8Array>;

export interface VariantPayload {
  readonly variantId: string;
  readonly name: string;
  readonly sku: string;
  readonly archived?: boolean;
}

/** A snapshot is parsed in memory; refuse one that would not fit a phone (a hostile or broken server). */
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const cursorKey = (d: Dataset) => `cursor:${d}`;
const bootKey = (d: Dataset) => `boot:${d}`;

/** `INSERT ... ON CONFLICT` for one entity row. */
const UPSERT = `INSERT INTO entities (dataset, entity, entity_id, version, payload, changed_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (dataset, entity, entity_id) DO UPDATE SET
    version = excluded.version, payload = excluded.payload, changed_at = excluded.changed_at`;

const isVariant = (dataset: Dataset, entity: string) =>
  dataset === "catalog" && entity === "variant";

/** Keeps the FTS5 index in step with variants: searchable unless archived or deleted. */
async function indexVariant(tx: Tx, variantId: string, payload: VariantPayload | undefined) {
  await tx.run("INSERT OR IGNORE INTO variant_index (variant_id) VALUES (?)", [variantId]);
  const row = await tx.get<{ variant_rowid: number }>(
    "SELECT variant_rowid FROM variant_index WHERE variant_id = ?",
    [variantId],
  );
  if (row === undefined) return;
  await tx.run("DELETE FROM variant_search WHERE rowid = ?", [row.variant_rowid]);
  if (payload !== undefined && payload.archived !== true) {
    await tx.run("INSERT INTO variant_search (rowid, name, sku) VALUES (?, ?, ?)", [
      row.variant_rowid,
      payload.name,
      payload.sku,
    ]);
  }
}

/** Applies one page inside the caller's transaction (entities, search index; the cursor is the caller's). */
export async function applyChanges(
  tx: Tx,
  dataset: Dataset,
  changes: readonly PullChange[],
): Promise<void> {
  for (const c of changes) {
    if (c.op === "delete") {
      await tx.run("DELETE FROM entities WHERE dataset = ? AND entity = ? AND entity_id = ?", [
        dataset,
        c.entity,
        c.entityId,
      ]);
      if (isVariant(dataset, c.entity)) await indexVariant(tx, c.entityId, undefined);
      continue;
    }
    await tx.run(UPSERT, [
      dataset,
      c.entity,
      c.entityId,
      c.version,
      JSON.stringify(c.payload),
      c.changedAt,
    ]);
    if (isVariant(dataset, c.entity)) {
      await indexVariant(tx, c.entityId, c.payload as VariantPayload);
    }
  }
}

interface SnapshotRow {
  entity: string;
  id: string;
  version: number;
  payload: unknown;
}

/** gzip NDJSON: a header line (`cursor`), then one `{ entity, id, version, payload }` per line. */
export function parseSnapshot(text: string): { cursor: string | null; rows: SnapshotRow[] } {
  const lines = text.split("\n");
  const head = JSON.parse(lines[0] ?? "null") as { cursor?: string | null } | null;
  if (head === null || typeof head !== "object" || !("cursor" in head)) {
    throw new Error("snapshot header is missing");
  }
  const rows: SnapshotRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line === "") continue;
    rows.push(JSON.parse(line) as SnapshotRow);
  }
  return { cursor: head.cursor ?? null, rows };
}

/** Replaces a dataset with a snapshot and sets its cursor, all or nothing. */
export async function applySnapshot(
  db: LocalDb,
  dataset: Dataset,
  snap: { cursor: string | null; rows: readonly SnapshotRow[] },
  now: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM entities WHERE dataset = ?", [dataset]);
    if (dataset === "catalog") {
      await tx.run("DELETE FROM variant_search");
      await tx.run("DELETE FROM variant_index");
    }
    const upsert = await tx.prepare(UPSERT);
    const changedAt = new Date(now).toISOString();
    for (const r of snap.rows) {
      await upsert.run([dataset, r.entity, r.id, r.version, JSON.stringify(r.payload), changedAt]);
      if (isVariant(dataset, r.entity)) await indexVariant(tx, r.id, r.payload as VariantPayload);
    }
    await upsert.finalize();
    await setCursor(tx, dataset, snap.cursor);
    await tx.run(
      "INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = '1'",
      [bootKey(dataset)],
    );
  });
}

async function setCursor(tx: Tx, dataset: Dataset, cursor: string | null): Promise<void> {
  if (cursor === null) {
    await tx.run("DELETE FROM kv WHERE key = ?", [cursorKey(dataset)]);
    return;
  }
  await tx.run(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [cursorKey(dataset), cursor],
  );
}

export type PullEvent =
  | { type: "bootstrapped"; dataset: Dataset; entities: number }
  | { type: "pulled"; dataset: Dataset; changes: number; pages: number }
  | { type: "error"; dataset: Dataset | undefined; error: unknown }
  | { type: "backoff"; attempt: number; delayMs: number };

export interface PullOptions {
  db: LocalDb;
  transport: PullTransport;
  gunzip: Gunzip;
  datasets: readonly Dataset[];
  /** After a page is committed (build or refresh in-memory indexes from it). */
  onChanges?: (dataset: Dataset, changes: readonly PullChange[]) => void;
  /** After a snapshot replaced a dataset (rebuild in-memory indexes from the database). */
  onReset?: (dataset: Dataset) => void;
  onEvent?: (e: PullEvent) => void;
  onMetric?: OnClientMetric;
  pageSize?: number;
  /** Fallback poll when no hint arrives (hints are best effort). */
  pollMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  timers?: Timers;
  now?: () => number;
  yieldToUi?: () => Promise<void>;
}

const isBadCursor = (e: unknown): boolean =>
  e instanceof TransportError &&
  (e.status === 422 || e.status === 400) &&
  e.code === "VALIDATION_FAILED";

/**
 * Keeps the local datasets current: bootstrap from a snapshot on first run, then keyset pages from the stored cursor.
 * One pull at a time (single flight); hints and the fallback poll only decide *when*. A page and its cursor commit in
 * one transaction, so a crash re-pulls at most one page (applying a page twice is a no-op: upserts by entity id).
 */
export function createPullLoop(opts: PullOptions) {
  const { db, transport } = opts;
  const emit = (e: PullEvent) => opts.onEvent?.(e);
  const pageSize = opts.pageSize ?? 500;
  const now = opts.now ?? Date.now;
  const timers = opts.timers ?? defaultTimers;
  const random = opts.random ?? Math.random;
  const sleeper = createSleeper(timers);
  const metric: OnClientMetric = (n, v, l) => opts.onMetric?.(n, v, l);

  const dirty = new Set<Dataset>();
  let current: Promise<void> | undefined;
  let stopped = false;
  // A function: stop() flips the flag while drain() is awaiting, which control-flow narrowing cannot see.
  const isStopped = (): boolean => stopped;
  let attempt = 0;
  let pollTimer: unknown;

  async function readCursor(dataset: Dataset): Promise<string | undefined> {
    return (
      await db.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", [cursorKey(dataset)])
    )?.value;
  }

  async function bootstrapDataset(dataset: Dataset): Promise<void> {
    const t0 = performance.now();
    const info = await transport.bootstrap(dataset);
    if (info.url === null) {
      // An empty dataset: nothing to download, just remember that it was bootstrapped.
      await applySnapshot(db, dataset, { cursor: info.cursor, rows: [] }, now());
    } else {
      const bytes = await opts.gunzip(await transport.download(info.url));
      if (bytes.length > MAX_SNAPSHOT_BYTES)
        throw new Error("the snapshot is larger than the device accepts");
      const text = fromUtf8(bytes);
      const snap = parseSnapshot(text);
      await applySnapshot(db, dataset, snap, now());
      emit({ type: "bootstrapped", dataset, entities: snap.rows.length });
    }
    opts.onReset?.(dataset);
    metric("bootstrap_ms", performance.now() - t0, { dataset });
  }

  async function pullDataset(dataset: Dataset): Promise<number> {
    let cursor = await readCursor(dataset);
    const booted =
      (await db.get("SELECT 1 FROM kv WHERE key = ?", [bootKey(dataset)])) !== undefined;
    if (!booted) {
      await bootstrapDataset(dataset);
      cursor = await readCursor(dataset);
    }
    let total = 0;
    let pages = 0;
    let rebooted = false;
    for (;;) {
      const t0 = performance.now();
      let page: ChangesPage | "not_modified";
      try {
        page = await transport.changes(dataset, cursor, pageSize);
      } catch (err) {
        if (!rebooted && isBadCursor(err)) {
          // The server no longer knows this cursor (compacted, restored): start again from a snapshot.
          rebooted = true;
          await bootstrapDataset(dataset);
          cursor = await readCursor(dataset);
          continue;
        }
        throw err;
      }
      metric("pull_page_ms", performance.now() - t0, { dataset });
      if (page === "not_modified") break;
      pages++;
      const t1 = performance.now();
      const next = page.nextCursor ?? cursor;
      // More pages promised but the cursor did not move: looping would never end.
      if (page.hasMore && next === cursor) throw new Error("the change feed made no progress");
      await db.transaction(async (tx) => {
        await applyChanges(tx, dataset, page.changes);
        if (next !== undefined) await setCursor(tx, dataset, next);
      });
      metric("pull_apply_ms", performance.now() - t1, {
        dataset,
        changes: String(page.changes.length),
      });
      total += page.changes.length;
      cursor = next;
      if (page.changes.length > 0) opts.onChanges?.(dataset, page.changes);
      if (!page.hasMore) break;
      await opts.yieldToUi?.();
    }
    if (total > 0 || pages > 0) emit({ type: "pulled", dataset, changes: total, pages });
    return total;
  }

  /** Pulls every dirty dataset, repeating while new hints arrive meanwhile. */
  async function drain(): Promise<void> {
    while (dirty.size > 0 && !isStopped()) {
      const batch = [...dirty];
      dirty.clear();
      let failed = false;
      for (const dataset of batch) {
        if (isStopped()) return;
        try {
          await pullDataset(dataset);
        } catch (error) {
          failed = true;
          dirty.add(dataset);
          emit({ type: "error", dataset, error });
          if (error instanceof TransportError && error.status === 401) {
            // Signed out: stop trying until the host calls `request` again after sign-in.
            dirty.clear();
            return;
          }
        }
      }
      if (failed) {
        const delayMs = backoffDelay({
          attempt,
          baseMs: opts.baseDelayMs ?? 1000,
          capMs: opts.maxDelayMs ?? 60_000,
          random,
        });
        attempt++;
        emit({ type: "backoff", attempt, delayMs });
        await sleeper.sleep(delayMs);
      } else attempt = 0;
    }
  }

  function request(datasets: readonly Dataset[] = opts.datasets): Promise<void> {
    if (isStopped()) return Promise.resolve();
    for (const d of datasets) if (opts.datasets.includes(d)) dirty.add(d);
    if (current !== undefined) return current;
    current = drain().finally(() => {
      current = undefined;
      if (dirty.size > 0 && !isStopped()) request([]).catch(() => undefined);
    });
    return current;
  }

  function schedulePoll(): void {
    if (stopped || opts.pollMs === undefined) return;
    pollTimer = timers.set(() => {
      request()
        .catch(() => undefined)
        .finally(schedulePoll);
    }, opts.pollMs);
  }

  return {
    /** Pull these datasets (all by default), now. Resolves when the queue is empty. */
    request,
    /** The network came back: skip a backoff wait and pull now. */
    networkUp(): Promise<void> {
      sleeper.wake();
      return request();
    },
    /** A realtime hint named these datasets. */
    hint: (datasets: readonly Dataset[]): Promise<void> => request(datasets),
    /** Starts the fallback poll and does a first full pull. */
    start(): Promise<void> {
      stopped = false;
      schedulePoll();
      return request();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (pollTimer !== undefined) timers.clear(pollTimer);
      sleeper.wake();
      await current;
    },
    /** Datasets not bootstrapped yet (the host shows "first sync" until this is empty). */
    async pendingBootstrap(): Promise<Dataset[]> {
      const out: Dataset[] = [];
      for (const d of opts.datasets) {
        if ((await db.get("SELECT 1 FROM kv WHERE key = ?", [bootKey(d)])) === undefined)
          out.push(d);
      }
      return out;
    },
  };
}

export type PullLoop = ReturnType<typeof createPullLoop>;
