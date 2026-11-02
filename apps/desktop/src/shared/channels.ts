/**
 * The whole surface between the sandboxed renderer and the main process. Every channel is listed here and nowhere else:
 * the preload exposes exactly these and the main process registers exactly these, so a new capability is a reviewed
 * change to this file (and to the allowlist test), never an ad-hoc `ipcRenderer.invoke`.
 */
export const CHANNELS = {
  dbOpen: "wb:db:open",
  dbExec: "wb:db:exec",
  dbRun: "wb:db:run",
  dbAll: "wb:db:all",
  dbGet: "wb:db:get",
  dbBegin: "wb:db:begin",
  dbCommit: "wb:db:commit",
  dbRollback: "wb:db:rollback",
  dbClose: "wb:db:close",
  vaultLoad: "wb:vault:load",
  vaultSave: "wb:vault:save",
  vaultClear: "wb:vault:clear",
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

export const ALL_CHANNELS: readonly Channel[] = Object.values(CHANNELS);

/** A value SQLite can bind. Structured clone carries all of these across IPC. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = readonly SqlValue[];
export type SqlRow = Record<string, unknown>;

export type DesktopPlatform = "windows" | "macos" | "linux";

/** What `window.wiseDesktop` looks like in the renderer. */
export interface DesktopBridge {
  readonly platform: DesktopPlatform;
  readonly version: string;
  readonly db: {
    readonly open: (deviceId: string) => Promise<void>;
    readonly exec: (sql: string) => Promise<void>;
    readonly run: (sql: string, params?: SqlParams) => Promise<{ changes: number }>;
    readonly all: (sql: string, params?: SqlParams) => Promise<SqlRow[]>;
    readonly get: (sql: string, params?: SqlParams) => Promise<SqlRow | undefined>;
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
