import { openLocalDb } from "@wise-biz/sync";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createDesktopVault, openDesktopSqlite } from "../src/runtime/desktop.ts";

import type { DesktopBridge } from "../src/runtime/desktop.ts";
import type { Row } from "@wise-biz/sync";

/** A bridge backed by better-sqlite3 in this process: what the Electron main process does behind IPC. */
function fakeBridge(): DesktopBridge & { vaultValue: string | undefined } {
  const db = new Database(":memory:");
  let vaultValue: string | undefined;
  const stmt = (sql: string) => db.prepare(sql);
  return {
    platform: "windows",
    get vaultValue() {
      return vaultValue;
    },
    db: {
      open: () => Promise.resolve(),
      exec: (sql) => {
        db.exec(sql);
        return Promise.resolve();
      },
      run: (sql, p = []) => {
        const s = stmt(sql);
        return Promise.resolve({ changes: s.reader ? 0 : s.run(...p).changes });
      },
      all: (sql, p = []) => {
        const s = stmt(sql);
        return Promise.resolve(s.reader ? (s.all(...p) as Row[]) : []);
      },
      get: (sql, p = []) => {
        const s = stmt(sql);
        return Promise.resolve(s.reader ? (s.get(...p) as Row | undefined) : undefined);
      },
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
    },
    vault: {
      load: () => Promise.resolve(vaultValue),
      save: (v) => {
        vaultValue = v;
        return Promise.resolve();
      },
      clear: () => {
        vaultValue = undefined;
        return Promise.resolve();
      },
    },
  };
}

describe("desktop storage adapter", () => {
  it("runs the sync schema, transactions and rollbacks through the bridge", async () => {
    const bridge = fakeBridge();
    const local = await openLocalDb(await openDesktopSqlite(bridge, "dev-1"));
    await local.run("INSERT INTO kv (key, value) VALUES (?, ?)", ["a", "1"]);
    await expect(
      local.transaction(async (tx) => {
        await tx.run("INSERT INTO kv (key, value) VALUES (?, ?)", ["b", "2"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await local.all("SELECT key FROM kv ORDER BY key")).toEqual([{ key: "a" }]);
    await local.close();
  });

  it("keeps the device identity through the vault and drops anything malformed", async () => {
    const bridge = fakeBridge();
    const vault = createDesktopVault(bridge);
    expect(await vault.load()).toBeUndefined();
    const identity = { deviceId: "d", tenantId: "t", branchId: "b", secretKey: "k" };
    await vault.save(identity);
    expect(await vault.load()).toEqual(identity);
    await bridge.vault.save("not json");
    expect(await vault.load()).toBeUndefined();
    await bridge.vault.save('{"deviceId":1}');
    expect(await vault.load()).toBeUndefined();
    await vault.clear();
    expect(await vault.load()).toBeUndefined();
  });
});
