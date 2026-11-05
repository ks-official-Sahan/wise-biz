import { generateKeyPair, publicKeyFrom, sign } from "@wise-biz/crypto";
import { HardwareError, DRAWER_KICK_BYTES } from "@wise-biz/hardware";
import { openLocalDb } from "@wise-biz/sync";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { receiptJob } from "../src/features/tender/model/drawer.ts";
import {
  createDesktopPrinter,
  createDesktopVault,
  desktopPrinterConfigured,
  openDesktopSqlite,
} from "../src/runtime/desktop.ts";

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
    hw: {
      config: () =>
        Promise.resolve({ printer: { kind: "none" as const }, scale: { kind: "none" as const } }),
      setConfig: (c) => Promise.resolve(c),
      print: () => Promise.resolve(),
      kick: () => Promise.resolve(),
      ports: () => Promise.resolve([]),
      scale: () => Promise.resolve(undefined),
    },
    display: {
      show: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      screens: () => Promise.resolve({ screens: [], chosen: null }),
      choose: () => Promise.resolve(),
    },
    kiosk: {
      status: () => Promise.resolve({ enabled: false, hasPin: false }),
      setPin: () => Promise.resolve(),
      setEnabled: () => Promise.resolve(),
      verify: () => Promise.resolve(true),
    },
    // Like the main process: the secrets stay in this closure and only public keys and signatures leave it.
    keyring: (() => {
      const secrets = new Map<string, Uint8Array>();
      return {
        generate: (id: string) => {
          const pair = generateKeyPair();
          secrets.set(id, pair.secretKey);
          return Promise.resolve(pair.publicKey);
        },
        open: (id: string) => {
          const secret = secrets.get(id);
          return Promise.resolve(secret === undefined ? undefined : publicKeyFrom(secret));
        },
        sign: (id: string, message: Uint8Array) => {
          const secret = secrets.get(id);
          return secret === undefined
            ? Promise.reject(new Error("No such key."))
            : Promise.resolve(sign(message, secret));
        },
        remove: (id: string) => {
          secrets.delete(id);
          return Promise.resolve();
        },
      };
    })(),
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

describe("desktop key custody", () => {
  it("signs through the main process and stores an identity with no secret", async () => {
    const bridge = fakeBridge();
    const vault = createDesktopVault(bridge);
    const signer = await vault.keyring?.generate("0198f3a2-aaaa-7bbb-8ccc-1234567890ab");
    expect(signer?.publicKey).toHaveLength(32);
    const message = new TextEncoder().encode("base");
    const signature = await signer?.sign(message);
    expect(signature).toHaveLength(64);
    const reopened = await vault.keyring?.open("0198f3a2-aaaa-7bbb-8ccc-1234567890ab");
    expect(reopened?.publicKey).toEqual(signer?.publicKey);
    await vault.keyring?.remove("0198f3a2-aaaa-7bbb-8ccc-1234567890ab");
    expect(await vault.keyring?.open("0198f3a2-aaaa-7bbb-8ccc-1234567890ab")).toBeUndefined();
  });
});

describe("desktop printer and drawer", () => {
  it("wraps the shell's printer and maps its failures to hardware errors", async () => {
    const bridge = fakeBridge();
    const sent: Uint8Array[] = [];
    let fail: string | undefined;
    const b = {
      ...bridge,
      hw: {
        ...bridge.hw,
        print: (bytes: Uint8Array) => {
          if (fail !== undefined) return Promise.reject(new Error(fail));
          sent.push(bytes);
          return Promise.resolve();
        },
      },
    };
    const printer = createDesktopPrinter(b);
    await printer.write(Uint8Array.of(1));
    expect(sent).toHaveLength(1);
    fail = "cannot reach printer at 10.0.0.9";
    await expect(printer.write(Uint8Array.of(1))).rejects.toMatchObject({ kind: "offline" });
    fail = "printer refused the job";
    const e = await printer.write(Uint8Array.of(1)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HardwareError);
    expect(e).toMatchObject({ kind: "rejected" });
    expect(await printer.status()).toBe("ready");
    expect(await desktopPrinterConfigured(bridge)).toBe(false);
    expect(
      await desktopPrinterConfigured({
        ...bridge,
        hw: {
          ...bridge.hw,
          config: () =>
            Promise.resolve({
              printer: { kind: "network" as const, host: "h", port: 1 },
              scale: { kind: "none" as const },
            }),
        },
      }),
    ).toBe(true);
    expect(
      await desktopPrinterConfigured({
        ...bridge,
        hw: { ...bridge.hw, config: () => Promise.reject(new Error("x")) },
      }),
    ).toBe(false);
  });

  it("appends the drawer pulse only when cash was taken", () => {
    const receipt = Uint8Array.of(7, 8);
    expect(receiptJob(receipt, [{ kind: "card" }])).toBe(receipt);
    expect([...receiptJob(receipt, [{ kind: "card" }, { kind: "cash" }])]).toEqual([
      7,
      8,
      ...DRAWER_KICK_BYTES,
    ]);
    expect(receiptJob(receipt, [])).toBe(receipt);
  });
});
