import type { DeviceIdentity, DeviceVault, Platform } from "../platform/index.ts";
import type { Prepared, Row, SqlParams, StorageAdapter } from "@wise-biz/sync";

/**
 * What the Electron preload exposes as `window.wiseDesktop` (the authoritative copy is `DesktopBridge` in
 * `apps/desktop/src/shared/channels.ts`; apps may not import each other, so the shape is repeated here).
 */
export interface DesktopBridge {
  readonly platform: Extract<Platform, "windows" | "macos" | "linux">;
  readonly db: {
    readonly open: (deviceId: string) => Promise<void>;
    readonly exec: (sql: string) => Promise<void>;
    readonly run: (sql: string, params?: SqlParams) => Promise<{ changes: number }>;
    readonly all: (sql: string, params?: SqlParams) => Promise<Row[]>;
    readonly get: (sql: string, params?: SqlParams) => Promise<Row | undefined>;
    readonly begin: () => Promise<void>;
    readonly commit: () => Promise<void>;
    readonly rollback: () => Promise<void>;
    readonly close: () => Promise<void>;
  };
  readonly vault: {
    readonly load: () => Promise<string | undefined>;
    readonly save: (value: string) => Promise<void>;
    readonly clear: () => Promise<void>;
  };
}

/** The bridge when the app runs inside the desktop shell, otherwise undefined (browser, Android, iOS). */
export function getDesktop(): DesktopBridge | undefined {
  const b = (globalThis as { wiseDesktop?: DesktopBridge }).wiseDesktop;
  return b ?? undefined;
}

/**
 * The sync package's storage port over the main process's better-sqlite3. Statements travel by SQL text (the main
 * process keeps its own prepared-statement cache), so `prepare` is a thin wrapper and `finalize` has nothing to free.
 */
export async function openDesktopSqlite(
  bridge: DesktopBridge,
  deviceId: string,
): Promise<StorageAdapter> {
  await bridge.db.open(deviceId);
  const db = bridge.db;
  const prepared = (sql: string): Prepared => ({
    all: <R = Row>(params?: SqlParams) => db.all(sql, params) as Promise<R[]>,
    get: <R = Row>(params?: SqlParams) => db.get(sql, params) as Promise<R | undefined>,
    run: (params?: SqlParams) => db.run(sql, params),
    finalize: () => Promise.resolve(),
  });
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.run(sql, params),
    all: <R = Row>(sql: string, params?: SqlParams) => db.all(sql, params) as Promise<R[]>,
    get: <R = Row>(sql: string, params?: SqlParams) =>
      db.get(sql, params) as Promise<R | undefined>,
    prepare: (sql) => Promise.resolve(prepared(sql)),
    begin: () => db.begin(),
    commit: () => db.commit(),
    rollback: () => db.rollback(),
    close: () => db.close(),
  };
}

const isIdentity = (v: unknown): v is DeviceIdentity => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.deviceId === "string" &&
    typeof o.tenantId === "string" &&
    typeof o.branchId === "string" &&
    typeof o.secretKey === "string"
  );
};

/** The device identity, encrypted by the main process with the OS credential store (Electron `safeStorage`). */
export function createDesktopVault(bridge: DesktopBridge): DeviceVault {
  return {
    load: async () => {
      const raw = await bridge.vault.load();
      if (raw === undefined) return undefined;
      try {
        const v: unknown = JSON.parse(raw);
        return isIdentity(v) ? v : undefined;
      } catch {
        return undefined;
      }
    },
    save: (i) => bridge.vault.save(JSON.stringify(i)),
    clear: () => bridge.vault.clear(),
  };
}
