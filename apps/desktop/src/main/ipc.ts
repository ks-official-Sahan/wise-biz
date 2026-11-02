import { CHANNELS } from "../shared/channels.ts";

import { isTrustedSender } from "./security.ts";

import type { StorageService } from "./storage.ts";
import type { createVaultStore } from "./vault.ts";

type Handler = (...args: unknown[]) => unknown;

/** The slice of `ipcMain` used, so the registration can be tested without Electron. */
export interface IpcMainLike {
  handle: (
    channel: string,
    listener: (
      event: { senderFrame?: { url: string; parent?: unknown } | null },
      ...args: unknown[]
    ) => unknown,
  ) => void;
}

/**
 * Registers every channel from `CHANNELS` and nothing else. Each handler first checks the sender's frame (only our own
 * origin), then validates its arguments in the service. Errors reach the renderer as plain messages without stacks.
 */
export function registerIpc(
  ipc: IpcMainLike,
  deps: { storage: StorageService; vault: ReturnType<typeof createVaultStore> },
): void {
  const { storage, vault } = deps;
  const table: Record<string, Handler> = {
    [CHANNELS.dbOpen]: (id) => {
      storage.open(id);
    },
    [CHANNELS.dbExec]: (sql) => {
      storage.exec(sql);
    },
    [CHANNELS.dbRun]: (sql, p) => storage.run(sql, p),
    [CHANNELS.dbAll]: (sql, p) => storage.all(sql, p),
    [CHANNELS.dbGet]: (sql, p) => storage.get(sql, p),
    [CHANNELS.dbBegin]: () => {
      storage.begin();
    },
    [CHANNELS.dbCommit]: () => {
      storage.commit();
    },
    [CHANNELS.dbRollback]: () => {
      storage.rollback();
    },
    [CHANNELS.dbClose]: () => {
      storage.close();
    },
    [CHANNELS.vaultLoad]: () => vault.load(),
    [CHANNELS.vaultSave]: (v) => vault.save(v),
    [CHANNELS.vaultClear]: () => {
      vault.clear();
    },
  };
  for (const [channel, fn] of Object.entries(table)) {
    ipc.handle(channel, async (event, ...args) => {
      // Top-level frame of our own origin only: an embedded frame never gets the bridge.
      if (!isTrustedSender(event.senderFrame?.url) || event.senderFrame?.parent != null)
        throw new Error("Untrusted sender.");
      try {
        return await fn(...args);
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : "Request failed.", { cause: e });
      }
    });
  }
}
