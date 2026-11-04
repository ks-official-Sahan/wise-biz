import { gunzipSync, gzipSync } from "node:zlib";

import { TransportError } from "../../src/push.ts";

import type {
  BootstrapInfo,
  ChangesPage,
  Dataset,
  PullChange,
  PullTransport,
} from "../../src/pull.ts";

interface Entry extends PullChange {
  readonly dataset: Dataset;
  readonly n: number;
}

export interface FakeFeed extends PullTransport {
  /** Appends a change; returns its position (the cursor value after it). */
  upsert: (dataset: Dataset, entity: string, entityId: string, payload: unknown) => number;
  remove: (dataset: Dataset, entity: string, entityId: string) => void;
  /** The current truth of a dataset: newest row per entity, deletes dropped. */
  state: (dataset: Dataset) => Map<string, unknown>;
  /** Forget history before the head: old cursors become invalid (compaction). */
  compact: () => void;
  readonly calls: { changes: number; bootstrap: number; download: number };
  /** Optional hook run before each `changes` call (throw to fail it). */
  beforeChanges?: ((dataset: Dataset, cursor: string | undefined) => void) | undefined;
  /** Return "not_modified" for a cursor that is already at the head. */
  etag: boolean;
}

const enc = (n: number) => `c${String(n)}`;
const dec = (c: string | undefined): number | undefined => {
  if (c === undefined) return 0;
  const m = /^c(\d+)$/.exec(c);
  return m === null ? undefined : Number(m[1]);
};

export function createFakeFeed(): FakeFeed {
  const log: Entry[] = [];
  let compactedBefore = 0;
  const feed: FakeFeed = {
    calls: { changes: 0, bootstrap: 0, download: 0 },
    etag: true,
    upsert(dataset, entity, entityId, payload) {
      const n = log.length + 1;
      log.push({
        dataset,
        n,
        entity,
        entityId,
        op: "upsert",
        version: 0,
        payload,
        changedAt: "2026-01-01T00:00:00.000Z",
      });
      return n;
    },
    remove(dataset, entity, entityId) {
      const n = log.length + 1;
      log.push({
        dataset,
        n,
        entity,
        entityId,
        op: "delete",
        version: 0,
        payload: null,
        changedAt: "2026-01-01T00:00:00.000Z",
      });
    },
    state(dataset) {
      const out = new Map<string, unknown>();
      for (const e of log) {
        if (e.dataset !== dataset) continue;
        const key = `${e.entity}/${e.entityId}`;
        if (e.op === "delete") out.delete(key);
        else out.set(key, e.payload);
      }
      return out;
    },
    compact() {
      compactedBefore = log.length;
    },
    changes(dataset, cursor, limit): Promise<ChangesPage | "not_modified"> {
      feed.calls.changes++;
      try {
        feed.beforeChanges?.(dataset, cursor);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      const from = dec(cursor);
      if (from === undefined || (cursor !== undefined && from < compactedBefore)) {
        return Promise.reject(
          new TransportError("bad cursor", { status: 422, code: "VALIDATION_FAILED" }),
        );
      }
      const rest = log.filter((e) => e.dataset === dataset && e.n > from);
      if (rest.length === 0 && feed.etag) return Promise.resolve("not_modified");
      const page = rest.slice(0, limit);
      const last = page.at(-1);
      return Promise.resolve({
        changes: page.map(({ entity, entityId, op, version, payload, changedAt }) => ({
          entity,
          entityId,
          op,
          version,
          payload,
          changedAt,
        })),
        nextCursor: last === undefined ? (cursor ?? null) : enc(last.n),
        hasMore: rest.length > page.length,
      });
    },
    bootstrap(dataset): Promise<BootstrapInfo> {
      feed.calls.bootstrap++;
      const entries = [...feed.state(dataset)];
      // The cursor is a position in the whole log (as the real feed's transaction position is), not in one dataset.
      const head = log.length === 0 ? undefined : { n: log.length };
      if (entries.length === 0 && head === undefined) {
        return Promise.resolve({ cursor: null, url: null });
      }
      const header = JSON.stringify({
        dataset,
        scope: "all",
        cursor: head ? enc(head.n) : null,
        builtAt: "x",
      });
      const lines = [
        header,
        ...entries.map(([key, payload]) => {
          const [entity = "", ...rest] = key.split("/");
          return JSON.stringify({ entity, id: rest.join("/"), version: 0, payload });
        }),
      ];
      snapshots.set(`mem://${dataset}`, gzipSync(Buffer.from(`${lines.join("\n")}\n`)));
      return Promise.resolve({ cursor: head ? enc(head.n) : null, url: `mem://${dataset}` });
    },
    download(url) {
      feed.calls.download++;
      const body = snapshots.get(url);
      return body === undefined
        ? Promise.reject(new TransportError("gone", { status: 404 }))
        : Promise.resolve(new Uint8Array(body));
    },
  };
  const snapshots = new Map<string, Buffer>();
  return feed;
}

export const gunzip = (bytes: Uint8Array): Promise<Uint8Array> =>
  Promise.resolve(new Uint8Array(gunzipSync(bytes)));
