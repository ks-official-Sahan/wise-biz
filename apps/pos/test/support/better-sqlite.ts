import Database from "better-sqlite3";

import type { Prepared, Row, SqlParams, StorageAdapter } from "@wise-biz/sync";

/**
 * better-sqlite3 behind the StorageAdapter port: the engine for Node tests now and for Electron later (the Electron
 * adapter ships with the desktop app in P1-12). The driver is synchronous, so each call resolves at once.
 */
export function betterSqliteAdapter(file = ":memory:"): StorageAdapter {
  const db = new Database(file);
  const wrap = (sql: string): Prepared => {
    const stmt = db.prepare(sql);
    const reader = stmt.reader;
    return {
      all: <R = Row>(params: SqlParams = []) =>
        Promise.resolve(reader ? (stmt.all(...params) as R[]) : (stmt.run(...params), [] as R[])),
      get: <R = Row>(params: SqlParams = []) =>
        Promise.resolve(
          reader ? (stmt.get(...params) as R | undefined) : (stmt.run(...params), undefined),
        ),
      run: (params: SqlParams = []) => Promise.resolve({ changes: stmt.run(...params).changes }),
      finalize: () => Promise.resolve(),
    };
  };
  return {
    exec: (sql) => {
      db.exec(sql);
      return Promise.resolve();
    },
    run: (sql, params) => wrap(sql).run(params),
    all: (sql, params) => wrap(sql).all(params),
    get: (sql, params) => wrap(sql).get(params),
    prepare: (sql) => Promise.resolve(wrap(sql)),
    begin: () => {
      db.exec("BEGIN IMMEDIATE");
      return Promise.resolve();
    },
    commit: () => {
      db.exec("COMMIT");
      return Promise.resolve();
    },
    rollback: () => {
      db.exec("ROLLBACK");
      return Promise.resolve();
    },
    close: () => {
      db.close();
      return Promise.resolve();
    },
  };
}
