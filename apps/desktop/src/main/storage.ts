import type { SqlRow } from "../shared/channels.ts";

/** The slice of better-sqlite3 the service uses (so tests and the real driver meet at one narrow seam). */
export interface Statement {
  readonly reader: boolean;
  run: (...params: unknown[]) => { changes: number | bigint };
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
}
export interface Driver {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => unknown;
  close: () => void;
}

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const MAX_SQL = 64 * 1024;

/**
 * Statements the renderer must never send: a second database file (ATTACH, VACUUM INTO), native extensions, and
 * pragmas that weaken durability. The schema code only needs the pragmas below, set once when the database opens.
 */
const FORBIDDEN = /^\s*(?:attach|detach|vacuum)\b/i;
const PRAGMA = /^\s*pragma\s+([a-z_]+)/i;
const SAFE_PRAGMAS = new Set([
  "journal_mode",
  "synchronous",
  "foreign_keys",
  "user_version",
  "busy_timeout",
  "temp_store",
]);
const PRAGMA_VALUES: Record<string, RegExp> = {
  journal_mode: /=\s*wal\b/i,
  synchronous: /=\s*(?:full|extra|2|3)\b/i,
};

export class StorageError extends Error {
  override readonly name = "StorageError";
}

/**
 * One SQLite file for the signed-in device, owned by the main process. The renderer's single-writer queue serialises
 * its calls; this service refuses anything that would break that contract (a second open, a statement with no database,
 * absurd input) instead of trusting the caller. WAL with `synchronous=FULL` comes from `openLocalDb` in `@wise-biz/sync`.
 */
export function createStorageService(o: {
  dir: string;
  open: (file: string) => Driver;
  join: (dir: string, name: string) => string;
}) {
  let db: Driver | undefined;
  let deviceId: string | undefined;
  const stmts = new Map<string, Statement>();

  const need = (): Driver => {
    if (db === undefined) throw new StorageError("The database is not open.");
    return db;
  };
  const sqlOf = (sql: unknown): string => {
    if (typeof sql !== "string" || sql === "" || sql.length > MAX_SQL)
      throw new StorageError("Invalid statement.");
    if (/load_extension/i.test(sql)) throw new StorageError("That statement is not allowed.");
    // The checks below look at the start of each statement, and SQLite skips comments before it, so a leading comment
    // ("/**/ATTACH ...", or a line comment then PRAGMA writable_schema=1) would walk past them. The app's statements never carry comments.
    if (sql.includes("/*") || sql.includes("--"))
      throw new StorageError("That statement is not allowed.");
    for (const part of sql.split(";")) {
      if (FORBIDDEN.test(part)) throw new StorageError("That statement is not allowed.");
      const m = PRAGMA.exec(part);
      if (m === null) continue;
      const name = (m[1] ?? "").toLowerCase();
      const value = PRAGMA_VALUES[name];
      const assigns = part.includes("=");
      if (!SAFE_PRAGMAS.has(name) || (assigns && value !== undefined && !value.test(part)))
        throw new StorageError("That statement is not allowed.");
      if (
        assigns &&
        value === undefined &&
        name !== "foreign_keys" &&
        name !== "busy_timeout" &&
        name !== "temp_store" &&
        name !== "user_version"
      )
        throw new StorageError("That statement is not allowed.");
    }
    return sql;
  };
  const stmt = (sql: string): Statement => {
    const d = need();
    let s = stmts.get(sql);
    if (s === undefined) {
      s = d.prepare(sql);
      if (stmts.size >= 128) {
        const oldest = stmts.keys().next();
        if (oldest.done !== true) stmts.delete(oldest.value);
      }
      stmts.set(sql, s);
    }
    return s;
  };
  const bindOf = (params: unknown): unknown[] => {
    if (params === undefined) return [];
    if (!Array.isArray(params) || params.length > 999)
      throw new StorageError("Invalid parameters.");
    for (const v of params as unknown[]) {
      const t = typeof v;
      if (!(
        v === null ||
        t === "string" ||
        t === "number" ||
        t === "bigint" ||
        v instanceof Uint8Array
      ))
        throw new StorageError("Invalid parameter type.");
    }
    return params as unknown[];
  };

  return {
    open(id: unknown): void {
      if (typeof id !== "string" || !DEVICE_ID.test(id))
        throw new StorageError("Invalid device id.");
      if (db !== undefined) {
        if (deviceId === id) return;
        throw new StorageError("A database is already open for another device.");
      }
      db = o.open(o.join(o.dir, `wise-biz-${id}.db`));
      deviceId = id;
    },
    exec(sql: unknown): void {
      need().exec(sqlOf(sql));
    },
    run(sql: unknown, params?: unknown): { changes: number } {
      const s = stmt(sqlOf(sql));
      const p = bindOf(params);
      return { changes: s.reader ? (s.all(...p), 0) : Number(s.run(...p).changes) };
    },
    all(sql: unknown, params?: unknown): SqlRow[] {
      const s = stmt(sqlOf(sql));
      const p = bindOf(params);
      return s.reader ? (s.all(...p) as SqlRow[]) : (s.run(...p), []);
    },
    get(sql: unknown, params?: unknown): SqlRow | undefined {
      const s = stmt(sqlOf(sql));
      const p = bindOf(params);
      return s.reader ? (s.get(...p) as SqlRow | undefined) : (s.run(...p), undefined);
    },
    begin(): void {
      need().exec("BEGIN IMMEDIATE");
    },
    commit(): void {
      need().exec("COMMIT");
    },
    rollback(): void {
      need().exec("ROLLBACK");
    },
    close(): void {
      stmts.clear();
      db?.close();
      db = undefined;
      deviceId = undefined;
    },
    isOpen: (): boolean => db !== undefined,
  };
}

export type StorageService = ReturnType<typeof createStorageService>;
