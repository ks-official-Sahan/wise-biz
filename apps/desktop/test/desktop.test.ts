import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { registerIpc } from "../src/main/ipc.ts";
import {
  APP_ORIGIN,
  buildCsp,
  isAllowedNavigation,
  isTrustedSender,
  needsHtmlFallback,
  resolveAsset,
} from "../src/main/security.ts";
import { createStorageService } from "../src/main/storage.ts";
import { createVaultStore } from "../src/main/vault.ts";
import { ALL_CHANNELS, CHANNELS } from "../src/shared/channels.ts";

import type { Driver } from "../src/main/storage.ts";
import type { SafeStorage, VaultFiles } from "../src/main/vault.ts";

const storage = () =>
  createStorageService({
    dir: "mem",
    join: (_d, n) => (n === "" ? "" : ":memory:"),
    open: (f) => new Database(f) as unknown as Driver,
  });

describe("navigation and assets", () => {
  it("allows only the app origin", () => {
    expect(isAllowedNavigation(`${APP_ORIGIN}/sell`)).toBe(true);
    expect(isAllowedNavigation("https://evil.example/")).toBe(false);
    expect(isAllowedNavigation("file:///etc/passwd")).toBe(false);
    expect(isAllowedNavigation("app://other/")).toBe(false);
    expect(isAllowedNavigation("not a url")).toBe(false);
    expect(isTrustedSender(undefined)).toBe(false);
    expect(isTrustedSender("https://evil.example/")).toBe(false);
    expect(isTrustedSender(`${APP_ORIGIN}/`)).toBe(true);
  });

  it("keeps asset paths inside the bundle", () => {
    const root = path.resolve("bundle");
    expect(resolveAsset(root, "/")).toBe(path.join(root, "index.html"));
    expect(resolveAsset(root, "/_expo/static/app.js")).toBe(path.join(root, "_expo/static/app.js"));
    expect(resolveAsset(root, "/../secret")).toBeUndefined();
    expect(resolveAsset(root, "/%2e%2e/secret")).toBeUndefined();
    expect(resolveAsset(root, "/a%00b")).toBeUndefined();
    expect(resolveAsset(root, "/a\\..\\b")).toBeUndefined();
    expect(resolveAsset(root, "/%E0%A4%A")).toBeUndefined();
    expect(needsHtmlFallback("/enroll")).toBe(true);
    expect(needsHtmlFallback("/app.js")).toBe(false);
  });

  it("builds a CSP that names only the API origin", () => {
    const csp = buildCsp({ apiOrigin: "https://api.example.com" });
    expect(csp).toContain("connect-src 'self' https://api.example.com");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/(?<!wasm-)unsafe-eval/);
    expect(csp).not.toContain("ws://");
    expect(buildCsp({ apiOrigin: "http://localhost:3000", dev: true })).toContain(
      "ws://localhost:*",
    );
  });
});

describe("storage service", () => {
  it("round-trips rows, transactions and rollbacks", () => {
    const s = storage();
    expect(() => {
      s.exec("SELECT 1");
    }).toThrow("not open");
    s.open("dev-1");
    s.open("dev-1");
    expect(() => {
      s.open("dev-2");
    }).toThrow("already open");
    s.exec("CREATE TABLE t (id integer PRIMARY KEY, v text)");
    s.begin();
    expect(s.run("INSERT INTO t (v) VALUES (?)", ["a"])).toEqual({ changes: 1 });
    s.rollback();
    expect(s.all("SELECT * FROM t")).toEqual([]);
    s.begin();
    s.run("INSERT INTO t (v) VALUES (?)", ["b"]);
    s.commit();
    expect(s.get("SELECT v FROM t WHERE id = ?", [1])).toEqual({ v: "b" });
    expect(s.get("SELECT v FROM t WHERE id = ?", [9])).toBeUndefined();
    expect(s.run("SELECT * FROM t")).toEqual({ changes: 0 });
    expect(s.all("INSERT INTO t (v) VALUES ('c')")).toEqual([]);
    expect(s.get("INSERT INTO t (v) VALUES ('d')")).toBeUndefined();
    expect(s.all("SELECT count(*) AS n FROM t")).toEqual([{ n: 3 }]);
    s.close();
    expect(s.isOpen()).toBe(false);
  });

  it("refuses bad ids, statements and parameters", () => {
    const s = storage();
    for (const id of ["", "../x", "a b", 5, "x".repeat(65)])
      expect(() => {
        s.open(id);
      }).toThrow("Invalid device id");
    s.open("dev");
    expect(() => s.run("", [])).toThrow("Invalid statement");
    expect(() => s.run("x".repeat(70_000))).toThrow("Invalid statement");
    expect(() => s.run("SELECT ?", "no")).toThrow("Invalid parameters");
    expect(() => s.run("SELECT ?", [{}])).toThrow("Invalid parameter type");
    expect(() => s.run("SELECT ?", new Array<number>(1000).fill(1))).toThrow("Invalid parameters");
    s.run("SELECT ?, ?, ?, ?, ?", [1n, null, new Uint8Array(2), "x", 1.5]);
  });

  it("caches statements up to a limit", () => {
    const s = storage();
    s.open("dev");
    for (let i = 0; i < 200; i++) expect(s.get(`SELECT ${String(i)} AS n`)).toEqual({ n: i });
  });
});

describe("vault", () => {
  const make = (strong: boolean, files: Map<string, Uint8Array>) => {
    const safe: SafeStorage = {
      isStrong: () => Promise.resolve(strong),
      encryptString: (s) => Promise.resolve(new TextEncoder().encode(`enc:${btoa(s)}`)),
      decryptString: (b) => {
        const t = new TextDecoder().decode(b);
        if (!t.startsWith("enc:")) return Promise.reject(new Error("bad"));
        return Promise.resolve(atob(t.slice(4)));
      },
    };
    const fs: VaultFiles = {
      read: (f) => files.get(f),
      write: (f, d) => void files.set(f, d),
      remove: (f) => void files.delete(f),
    };
    return createVaultStore({ file: "id.bin", safe, files: fs });
  };

  it("stores only encrypted bytes and reads them back", async () => {
    const files = new Map<string, Uint8Array>();
    const v = make(true, files);
    expect(await v.load()).toBeUndefined();
    await v.save('{"secretKey":"s3cret"}');
    expect(new TextDecoder().decode(files.get("id.bin"))).not.toContain('{"secretKey"');
    expect(await v.load()).toBe('{"secretKey":"s3cret"}');
    v.clear();
    expect(await v.load()).toBeUndefined();
  });

  it("treats an undecryptable file as absent and refuses a weak key store", async () => {
    const files = new Map<string, Uint8Array>([["id.bin", new TextEncoder().encode("garbage")]]);
    expect(await make(true, files).load()).toBeUndefined();
    const weak = make(false, new Map());
    await expect(weak.save("x")).rejects.toThrow("no protected key store");
    await expect(make(true, new Map()).save("")).rejects.toThrow("Invalid vault value");
    await expect(make(true, new Map()).save(5)).rejects.toThrow("Invalid vault value");
  });
});

describe("ipc", () => {
  it("registers exactly the allowlisted channels and checks the sender", async () => {
    const handlers = new Map<
      string,
      (e: { senderFrame?: { url: string } | null }, ...a: unknown[]) => unknown
    >();
    const s = storage();
    registerIpc(
      { handle: (c, l) => void handlers.set(c, l) },
      {
        storage: s,
        vault: createVaultStore({
          file: "f",
          safe: {
            isStrong: () => Promise.resolve(true),
            encryptString: () => Promise.resolve(new Uint8Array()),
            decryptString: () => Promise.resolve("v"),
          },
          files: { read: () => new Uint8Array(1), write: () => undefined, remove: () => undefined },
        }),
      },
    );
    expect([...handlers.keys()].sort()).toEqual([...ALL_CHANNELS].sort());
    const ok = { senderFrame: { url: `${APP_ORIGIN}/` } };
    const call = (channel: string, e: { senderFrame?: { url: string } | null }, ...a: unknown[]) =>
      Promise.resolve(handlers.get(channel)?.(e, ...a));
    const evil = { senderFrame: { url: "https://evil.example/" } };
    await expect(call(CHANNELS.dbExec, evil, "SELECT 1")).rejects.toThrow("Untrusted sender");
    await expect(call(CHANNELS.dbExec, { senderFrame: null }, "SELECT 1")).rejects.toThrow(
      "Untrusted sender",
    );
    await expect(call(CHANNELS.dbExec, ok, "SELECT 1")).rejects.toThrow("not open");
    await call(CHANNELS.dbOpen, ok, "dev");
    expect(await call(CHANNELS.dbAll, ok, "SELECT 1 AS n")).toEqual([{ n: 1 }]);
    expect(await call(CHANNELS.vaultLoad, ok)).toBe("v");
    await call(CHANNELS.dbClose, ok);
  });
});

describe("hardening", () => {
  it("refuses statements that reach outside the device database", () => {
    const s = storage();
    s.open("dev");
    for (const sql of [
      "ATTACH DATABASE 'x.db' AS x",
      "  detach x",
      "VACUUM INTO 'copy.db'",
      "PRAGMA synchronous = OFF",
      "PRAGMA journal_mode = DELETE",
      "PRAGMA writable_schema = 1",
      "SELECT load_extension('x')",
      "SELECT 1; PRAGMA cache_size = 1",
      "SELECT 1; ATTACH DATABASE 'x' AS x",
    ])
      expect(() => {
        s.exec(sql);
      }, sql).toThrow("not allowed");
    // The exact statement `openLocalDb` sends when it opens a database.
    s.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;",
    );
    s.exec("PRAGMA journal_mode = WAL");
    s.exec("PRAGMA synchronous = FULL");
    s.exec("PRAGMA foreign_keys = ON");
    expect(s.all("PRAGMA user_version")).toEqual([{ user_version: 0 }]);
  });

  it("answers only the top-level frame of the app", async () => {
    const handlers = new Map<
      string,
      (e: { senderFrame?: { url: string; parent?: unknown } | null }, ...a: unknown[]) => unknown
    >();
    registerIpc(
      {
        handle: (c, l) => {
          handlers.set(c, l);
        },
      },
      {
        storage: storage(),
        vault: createVaultStore({
          file: "f",
          safe: {
            isStrong: () => Promise.resolve(true),
            encryptString: () => Promise.resolve(new Uint8Array()),
            decryptString: () => Promise.resolve("v"),
          },
          files: { read: () => undefined, write: () => undefined, remove: () => undefined },
        }),
      },
    );
    const child = { senderFrame: { url: `${APP_ORIGIN}/`, parent: {} } };
    await expect(Promise.resolve(handlers.get(CHANNELS.vaultLoad)?.(child))).rejects.toThrow(
      "Untrusted sender",
    );
  });

  it("does not release the identity on a weak key store", async () => {
    const files = new Map([["id.bin", new Uint8Array([1])]]);
    const v = createVaultStore({
      file: "id.bin",
      safe: {
        isStrong: () => Promise.resolve(false),
        encryptString: () => Promise.resolve(new Uint8Array()),
        decryptString: () => Promise.resolve("secret"),
      },
      files: { read: (f) => files.get(f), write: () => undefined, remove: () => undefined },
    });
    expect(await v.load()).toBeUndefined();
  });
});
