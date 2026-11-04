import { HardwareError } from "@wise-biz/hardware";

import type { DeviceIdentity, DeviceVault, Platform } from "../platform/index.ts";
import type { Printer } from "@wise-biz/hardware";
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
  readonly hw: {
    readonly config: () => Promise<HardwareConfig>;
    readonly setConfig: (config: HardwareConfig) => Promise<HardwareConfig>;
    readonly print: (bytes: Uint8Array) => Promise<void>;
    readonly kick: () => Promise<void>;
    readonly ports: () => Promise<{ path: string; manufacturer?: string | undefined }[]>;
    readonly scale: () => Promise<{ grams: number; stable: boolean } | undefined>;
  };
  readonly display: {
    readonly show: (state: DisplayState) => Promise<void>;
    readonly clear: () => Promise<void>;
    readonly screens: () => Promise<{ screens: ScreenInfo[]; chosen: number | null }>;
    readonly choose: (screenId: number | null) => Promise<void>;
  };
  readonly kiosk: {
    readonly status: () => Promise<{ enabled: boolean; hasPin: boolean }>;
    readonly setPin: (pin: string, current?: string) => Promise<void>;
    readonly setEnabled: (enabled: boolean, pin?: string) => Promise<void>;
    readonly verify: (pin: string) => Promise<boolean>;
  };
  readonly vault: {
    readonly load: () => Promise<string | undefined>;
    readonly save: (value: string) => Promise<void>;
    readonly clear: () => Promise<void>;
  };
}

export type PrinterConfig =
  | { readonly kind: "none" }
  | { readonly kind: "network"; readonly host: string; readonly port: number }
  | { readonly kind: "serial"; readonly path: string; readonly baudRate: number };
export interface HardwareConfig {
  readonly printer: PrinterConfig;
  readonly scale:
    | { readonly kind: "none" }
    | { readonly kind: "serial"; readonly path: string; readonly baudRate: number };
}
export interface DisplayState {
  readonly lines: readonly { name: string; qty: string; totalMinor: number }[];
  readonly totalMinor: number;
  readonly changeMinor: number;
  readonly currency: string;
  readonly message?: string | undefined;
}
export interface ScreenInfo {
  readonly id: number;
  readonly label: string;
  readonly primary: boolean;
  readonly width: number;
  readonly height: number;
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

/** The printer the desktop shell has configured, behind the hardware port. Failures keep the shell's message. */
export function createDesktopPrinter(bridge: DesktopBridge): Printer {
  return {
    write: async (bytes) => {
      try {
        await bridge.hw.print(bytes);
      } catch (e) {
        const message = e instanceof Error ? e.message : "The printer failed.";
        throw new HardwareError(
          /cannot reach|No printer/i.test(message) ? "offline" : "rejected",
          message,
        );
      }
    },
    status: () => Promise.resolve("ready"),
  };
}

/** Reads the shell's saved hardware settings once; true when a printer is set up. */
export async function desktopPrinterConfigured(bridge: DesktopBridge): Promise<boolean> {
  try {
    return (await bridge.hw.config()).printer.kind !== "none";
  } catch {
    return false;
  }
}
