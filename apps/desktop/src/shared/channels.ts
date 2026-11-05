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
  keyGenerate: "wb:key:generate",
  keyOpen: "wb:key:open",
  keySign: "wb:key:sign",
  keyRemove: "wb:key:remove",
  hwConfig: "wb:hw:config",
  hwSetConfig: "wb:hw:set-config",
  hwPrint: "wb:hw:print",
  hwKick: "wb:hw:kick",
  hwPorts: "wb:hw:ports",
  hwScale: "wb:hw:scale",
  displayShow: "wb:display:show",
  displayClear: "wb:display:clear",
  displayScreens: "wb:display:screens",
  displayChoose: "wb:display:choose",
  kioskStatus: "wb:kiosk:status",
  kioskSetPin: "wb:kiosk:set-pin",
  kioskSetEnabled: "wb:kiosk:set-enabled",
  kioskVerify: "wb:kiosk:verify",
} as const;

/** Main to the customer display window (a separate, listen-only preload; not part of the invoke allowlist). */
export const DISPLAY_PUSH = "wb:display:state";

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

export const ALL_CHANNELS: readonly Channel[] = Object.values(CHANNELS);

/** A value SQLite can bind. Structured clone carries all of these across IPC. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = readonly SqlValue[];
export type SqlRow = Record<string, unknown>;

export type PrinterConfig =
  | { readonly kind: "none" }
  | { readonly kind: "network"; readonly host: string; readonly port: number }
  | { readonly kind: "serial"; readonly path: string; readonly baudRate: number };
export type ScaleConfig =
  | { readonly kind: "none" }
  | { readonly kind: "serial"; readonly path: string; readonly baudRate: number };
export interface HardwareConfig {
  readonly printer: PrinterConfig;
  readonly scale: ScaleConfig;
}
export interface PortInfo {
  readonly path: string;
  readonly manufacturer?: string | undefined;
}
export interface ScaleReading {
  readonly grams: number;
  readonly stable: boolean;
}

export interface DisplayState {
  readonly lines: readonly {
    readonly name: string;
    readonly qty: string;
    readonly totalMinor: number;
  }[];
  readonly totalMinor: number;
  readonly changeMinor: number;
  readonly currency: string;
  readonly message?: string | undefined;
  readonly qrUrl?: string | undefined;
}
export interface ScreenInfo {
  readonly id: number;
  readonly label: string;
  readonly primary: boolean;
  readonly width: number;
  readonly height: number;
}
export interface KioskStatus {
  readonly enabled: boolean;
  readonly hasPin: boolean;
}

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
  readonly hw: {
    readonly config: () => Promise<HardwareConfig>;
    readonly setConfig: (config: HardwareConfig) => Promise<HardwareConfig>;
    readonly print: (bytes: Uint8Array) => Promise<void>;
    readonly kick: () => Promise<void>;
    readonly ports: () => Promise<PortInfo[]>;
    readonly scale: () => Promise<ScaleReading | undefined>;
  };
  readonly display: {
    readonly show: (state: DisplayState) => Promise<void>;
    readonly clear: () => Promise<void>;
    readonly screens: () => Promise<{ screens: ScreenInfo[]; chosen: number | null }>;
    readonly choose: (screenId: number | null) => Promise<void>;
  };
  readonly kiosk: {
    readonly status: () => Promise<KioskStatus>;
    readonly setPin: (pin: string, current?: string) => Promise<void>;
    readonly setEnabled: (enabled: boolean, pin?: string) => Promise<void>;
    readonly verify: (pin: string) => Promise<boolean>;
  };
  readonly vault: {
    readonly load: () => Promise<string | undefined>;
    readonly save: (value: string) => Promise<void>;
    readonly clear: () => Promise<void>;
  };
  /** Device signing keys held by the main process: the renderer gets public keys and signatures, never a secret. */
  readonly keyring: {
    readonly generate: (keyId: string) => Promise<Uint8Array>;
    readonly open: (keyId: string) => Promise<Uint8Array | undefined>;
    readonly sign: (keyId: string, message: Uint8Array) => Promise<Uint8Array>;
    readonly remove: (keyId: string) => Promise<void>;
  };
}
