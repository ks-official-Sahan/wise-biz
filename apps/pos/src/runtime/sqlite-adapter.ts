import { openDatabaseAsync } from "expo-sqlite";

import type { Prepared, Row, SqlParams, StorageAdapter } from "@wise-biz/sync";
import type { SQLiteBindValue, SQLiteDatabase } from "expo-sqlite";

const bind = (params: SqlParams | undefined): SQLiteBindValue[] =>
  (params ?? []).map((v) => (typeof v === "bigint" ? Number(v) : v));

/**
 * expo-sqlite behind the sync package's StorageAdapter (native and web). Transactions are explicit BEGIN IMMEDIATE /
 * COMMIT statements: the single-writer queue in front of this adapter guarantees nothing else runs in between, so
 * expo's own transaction helpers (not available on web) are not needed.
 */
export async function openExpoSqlite(deviceId: string): Promise<StorageAdapter> {
  const db: SQLiteDatabase = await openDatabaseAsync(`wise-biz-${deviceId}.db`);
  const prepare = async (sql: string): Promise<Prepared> => {
    const stmt = await db.prepareAsync(sql);
    return {
      all: async <R = Row>(params?: SqlParams) => {
        const result = await stmt.executeAsync<R>(bind(params));
        try {
          return await result.getAllAsync();
        } finally {
          await result.resetAsync();
        }
      },
      get: async <R = Row>(params?: SqlParams) => {
        const result = await stmt.executeAsync<R>(bind(params));
        try {
          return (await result.getFirstAsync()) ?? undefined;
        } finally {
          await result.resetAsync();
        }
      },
      run: async (params?: SqlParams) => {
        const result = await stmt.executeAsync(bind(params));
        const changes = result.changes;
        await result.resetAsync();
        return { changes };
      },
      finalize: () => stmt.finalizeAsync(),
    };
  };
  const once = async <T>(sql: string, fn: (p: Prepared) => Promise<T>): Promise<T> => {
    const p = await prepare(sql);
    try {
      return await fn(p);
    } finally {
      await p.finalize();
    }
  };
  return {
    exec: (sql) => db.execAsync(sql),
    run: (sql, params) => once(sql, (p) => p.run(params)),
    all: <R = Row>(sql: string, params?: SqlParams) => once(sql, (p) => p.all<R>(params)),
    get: <R = Row>(sql: string, params?: SqlParams) => once(sql, (p) => p.get<R>(params)),
    prepare,
    begin: () => db.execAsync("BEGIN IMMEDIATE"),
    commit: () => db.execAsync("COMMIT"),
    rollback: () => db.execAsync("ROLLBACK"),
    close: () => db.closeAsync(),
  };
}
