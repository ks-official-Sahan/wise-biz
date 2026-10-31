/** Values SQLite stores. JSON goes in as text, binary as Uint8Array, 64-bit integers as bigint. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = readonly SqlValue[];
export type Row = Record<string, SqlValue>;

export interface RunResult {
  /** Rows changed by the statement. */
  readonly changes: number;
}

export interface Prepared {
  all: <R = Row>(params?: SqlParams) => Promise<R[]>;
  get: <R = Row>(params?: SqlParams) => Promise<R | undefined>;
  run: (params?: SqlParams) => Promise<RunResult>;
  finalize: () => Promise<void>;
}

/** What a transaction body may do. Every call is a statement inside the one open transaction. */
export interface Queryable {
  exec: (sql: string) => Promise<void>;
  run: (sql: string, params?: SqlParams) => Promise<RunResult>;
  all: <R = Row>(sql: string, params?: SqlParams) => Promise<R[]>;
  get: <R = Row>(sql: string, params?: SqlParams) => Promise<R | undefined>;
  prepare: (sql: string) => Promise<Prepared>;
}

/**
 * The one door to a device's SQLite file. Implemented per platform (expo-sqlite for native and web, better-sqlite3 for
 * Node tests and Electron). The adapter itself is not concurrency-safe: it is always used through `openLocalDb`, which
 * puts a single-writer queue in front of it.
 *
 * `begin`/`commit`/`rollback` are separate calls (not one callback) so adapters whose driver is async can implement
 * them, and the queue, not the adapter, decides who owns the connection.
 */
export interface StorageAdapter extends Queryable {
  /** Starts a write transaction that takes the write lock at once (`BEGIN IMMEDIATE`). */
  begin: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  close: () => Promise<void>;
}
