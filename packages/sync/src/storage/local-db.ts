import type { Prepared, Queryable, Row, RunResult, SqlParams, StorageAdapter } from "./port.ts";

/** A transaction handle: the same statements as the database, but inside the open transaction. */
export type Tx = Queryable;

export class StorageClosedError extends Error {
  constructor() {
    super("The local database is closed");
    this.name = "StorageClosedError";
  }
}

export interface LocalDb extends Queryable {
  /**
   * Runs `fn` in one write transaction and commits when it resolves; any throw rolls everything back and rethrows.
   * The queue is held for the whole call, so do not call `db.*` from inside `fn` (use `tx`): it would wait for the
   * transaction it is part of.
   */
  transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

const MAX_CACHED_STATEMENTS = 128;

/**
 * Single-writer queue in front of a StorageAdapter. SQLite has one writer; on web and native two overlapping async
 * callers would interleave statements inside someone else's transaction. Here every call, and every transaction as a
 * whole, runs strictly in arrival order. That order is also the order commands reach the outbox.
 */
export function createLocalDb(adapter: StorageAdapter): LocalDb {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new StorageClosedError());
    const result = tail.then(() => {
      if (closed) throw new StorageClosedError();
      return job();
    });
    // The chain continues whether this job failed or not; the caller still sees the failure.
    tail = result.catch(() => undefined);
    return result;
  };

  // Statement cache by SQL text: prepared once per connection, reused by every caller (queue-serialized, so safe).
  const cache = new Map<string, Prepared>();
  const prepared = async (sql: string): Promise<Prepared> => {
    const hit = cache.get(sql);
    if (hit !== undefined) {
      cache.delete(sql);
      cache.set(sql, hit); // most recently used last
      return hit;
    }
    const stmt = await adapter.prepare(sql);
    cache.set(sql, stmt);
    if (cache.size > MAX_CACHED_STATEMENTS) {
      // Map keeps insertion order and hits move to the end, so the first entry is the least recently used.
      for (const [sql0, old] of cache) {
        cache.delete(sql0);
        await old.finalize();
        break;
      }
    }
    return stmt;
  };

  const direct: Queryable = {
    exec: (sql) => adapter.exec(sql),
    run: async (sql, params) => (await prepared(sql)).run(params),
    all: async <R = Row>(sql: string, params?: SqlParams) => (await prepared(sql)).all<R>(params),
    get: async <R = Row>(sql: string, params?: SqlParams) => (await prepared(sql)).get<R>(params),
    prepare: (sql) => adapter.prepare(sql),
  };

  return {
    exec: (sql) => enqueue(() => direct.exec(sql)),
    run: (sql, params) => enqueue<RunResult>(() => direct.run(sql, params)),
    all: <R = Row>(sql: string, params?: SqlParams) => enqueue(() => direct.all<R>(sql, params)),
    get: <R = Row>(sql: string, params?: SqlParams) => enqueue(() => direct.get<R>(sql, params)),
    prepare: (sql) => enqueue(() => direct.prepare(sql)),
    transaction: <T>(fn: (tx: Tx) => Promise<T>) =>
      enqueue(async () => {
        await adapter.begin();
        try {
          const out = await fn(direct);
          await adapter.commit();
          return out;
        } catch (err) {
          try {
            await adapter.rollback();
          } catch {
            // the original failure is the one to report; a failed rollback leaves the connection to be closed
          }
          throw err;
        }
      }),
    close: async () => {
      await tail;
      if (closed) return;
      closed = true;
      for (const s of cache.values()) await s.finalize();
      cache.clear();
      await adapter.close();
    },
  };
}
