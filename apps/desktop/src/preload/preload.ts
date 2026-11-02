import { contextBridge, ipcRenderer } from "electron";

import { CHANNELS } from "../shared/channels.ts";

import type { DesktopBridge, DesktopPlatform, SqlParams } from "../shared/channels.ts";

// The preload runs sandboxed: no Node, only `electron`'s renderer modules. Everything below forwards one fixed channel.
const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const PLATFORMS: Record<string, DesktopPlatform> = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
};

const bridge: DesktopBridge = {
  platform: PLATFORMS[process.platform] ?? "linux",
  version: process.versions.electron,
  db: {
    open: (id) => call(CHANNELS.dbOpen, id),
    exec: (sql) => call(CHANNELS.dbExec, sql),
    run: (sql, p?: SqlParams) => call(CHANNELS.dbRun, sql, p),
    all: (sql, p?: SqlParams) => call(CHANNELS.dbAll, sql, p),
    get: (sql, p?: SqlParams) => call(CHANNELS.dbGet, sql, p),
    begin: () => call(CHANNELS.dbBegin),
    commit: () => call(CHANNELS.dbCommit),
    rollback: () => call(CHANNELS.dbRollback),
    close: () => call(CHANNELS.dbClose),
  },
  hw: {
    config: () => call(CHANNELS.hwConfig),
    setConfig: (c) => call(CHANNELS.hwSetConfig, c),
    print: (b) => call(CHANNELS.hwPrint, b),
    kick: () => call(CHANNELS.hwKick),
    ports: () => call(CHANNELS.hwPorts),
    scale: () => call(CHANNELS.hwScale),
  },
  vault: {
    load: () => call(CHANNELS.vaultLoad),
    save: (v) => call(CHANNELS.vaultSave, v),
    clear: () => call(CHANNELS.vaultClear),
  },
};

contextBridge.exposeInMainWorld("wiseDesktop", bridge);
