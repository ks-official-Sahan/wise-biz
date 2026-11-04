import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalDb,
  LATEST_VERSION,
  MIGRATIONS,
  openLocalDb,
  StorageClosedError,
} from "../src/index.ts";

import { betterSqliteAdapter } from "./support/better-sqlite.ts";

import type { LocalDb } from "../src/index.ts";

const dirs: string[] = [];
// Under node_modules (git-ignored, on the repo drive): the OS temp dir can sit behind a virus scanner that makes
// fsync jitter by 100 ms, which would make the durability tests flaky.
const base = join(import.meta.dirname, "..", "node_modules", ".cache", "wb-sync-test");
const tmp = () => {
  mkdirSync(base, { recursive: true });
  const d = mkdtempSync(join(base, "db-"));
  dirs.push(d);
  return join(d, "device.db");
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const memory = () => createLocalDb(betterSqliteAdapter());
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("single-writer queue", () => {
  it("runs overlapping callers strictly in arrival order, a transaction as one unit", async () => {
    const db = memory();
    await db.exec("create table t (n integer)");
    const order: string[] = [];
    const a = db.transaction(async (tx) => {
      await tx.run("insert into t values (1)");
      await delay(20);
      order.push("a-before-commit");
      await tx.run("insert into t values (2)");
    });
    // These arrive while `a` is open: they see all of its rows or none, never half of them.
    const seen = Promise.all([
      db.get<{ n: number }>("select count(*) as n from t"),
      db.run("insert into t values (3)").then(() => order.push("c-ran")),
    ]);
    await a;
    const [count] = await seen;
    expect(count?.n).toBe(2);
    expect(order).toEqual(["a-before-commit", "c-ran"]);
    await db.close();
  });

  it("rolls everything back when the body throws, and keeps working", async () => {
    const db = memory();
    await db.exec("create table t (n integer primary key)");
    await expect(
      db.transaction(async (tx) => {
        await tx.run("insert into t values (1)");
        await tx.run("insert into t values (1)");
      }),
    ).rejects.toThrow(/UNIQUE/);
    expect(await db.all("select * from t")).toEqual([]);
    await db.run("insert into t values (7)");
    expect(await db.all("select n from t")).toEqual([{ n: 7 }]);
    await db.close();
  });

  it("a failing job does not poison the queue", async () => {
    const db = memory();
    const bad = db.exec("this is not sql");
    const good = db.get<{ one: number }>("select 1 as one");
    await expect(bad).rejects.toThrow();
    expect(await good).toEqual({ one: 1 });
    await db.close();
  });

  it("refuses work after close, and close waits for queued work", async () => {
    const db = memory();
    await db.exec("create table t (n integer)");
    const queued = db.run("insert into t values (1)");
    const closing = db.close();
    await queued;
    await closing;
    await expect(db.run("insert into t values (2)")).rejects.toBeInstanceOf(StorageClosedError);
    await db.close();
  });

  it("work queued while close is waiting is refused, not run on a closed connection", async () => {
    const db = memory();
    await db.exec("create table t (n integer)");
    const closing = db.close();
    const late = db.run("insert into t values (1)");
    await closing;
    await expect(late).rejects.toBeInstanceOf(StorageClosedError);
  });

  it("reuses prepared statements and evicts the least recently used past the cap", async () => {
    const db = memory();
    await db.exec("create table t (n integer)");
    for (let i = 0; i < 200; i++) await db.get(`select ${String(i)} as v`);
    for (let i = 0; i < 20; i++) await db.run("insert into t values (?)", [i]);
    expect(await db.get<{ c: number }>("select count(*) as c from t")).toEqual({ c: 20 });
    expect(await db.get<{ v: number }>("select 199 as v")).toEqual({ v: 199 });
    await db.close();
  });

  it("run reports changes, get is undefined without a match, prepare works in and out of a tx", async () => {
    const db = memory();
    await db.exec("create table t (n integer)");
    expect(await db.run("insert into t values (1), (2)")).toEqual({ changes: 2 });
    expect(await db.get("select * from t where n = 9")).toBeUndefined();
    const p = await db.prepare("select n from t order by n");
    expect(await p.all()).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await p.get()).toEqual({ n: 1 });
    await p.finalize();
    await db.transaction(async (tx) => {
      const w = await tx.prepare("insert into t values (?)");
      expect(await w.run([3])).toEqual({ changes: 1 });
      expect(await w.all([4])).toEqual([]);
      expect(await w.get([5])).toBeUndefined();
      expect(await tx.all("select count(*) as c from t")).toEqual([{ c: 5 }]);
    });
    await db.close();
  });
});

describe("openLocalDb", () => {
  it("creates the schema once, idempotently, with durable pragmas", async () => {
    const file = tmp();
    let db = await openLocalDb(betterSqliteAdapter(file), { now: () => 1234 });
    expect(await db.all("select applied_at from _migrations")).toEqual(
      MIGRATIONS.map(() => ({ applied_at: 1234 })),
    );
    const mode = await db.get<{ journal_mode: string }>("PRAGMA journal_mode");
    const sync = await db.get<{ synchronous: number }>("PRAGMA synchronous");
    expect(mode?.journal_mode).toBe("wal");
    expect(sync?.synchronous).toBe(2);
    const tables = await db.all<{ name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'variant_search_%' order by name",
    );
    expect(tables.map((t) => t.name)).toEqual([
      "_migrations",
      "device_outbox",
      "drafts",
      "entities",
      "kv",
      "local_cash_movements",
      "local_movements",
      "local_returns",
      "local_sales",
      "local_shifts",
      "variant_index",
      "variant_search",
    ]);
    await db.close();
    db = await openLocalDb(betterSqliteAdapter(file));
    expect(await db.all("select version from _migrations order by version")).toEqual(
      MIGRATIONS.map((m) => ({ version: m.version })),
    );
    await db.close();
  });

  it("refuses a database written by a newer app", async () => {
    const file = tmp();
    const db = await openLocalDb(betterSqliteAdapter(file));
    await db.run("insert into _migrations values (?, 0)", [LATEST_VERSION + 1]);
    await db.close();
    await expect(openLocalDb(betterSqliteAdapter(file))).rejects.toThrow(/update the app/);
  });

  it("a failed migration leaves no half-applied version", async () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2]);
    const adapter = betterSqliteAdapter(tmp());
    const begin = adapter.begin.bind(adapter);
    let begins = 0;
    adapter.begin = async () => {
      begins++;
      if (begins === 1) throw new Error("power cut");
      await begin();
    };
    await expect(openLocalDb(adapter)).rejects.toThrow("power cut");
    await adapter.close();
  });

  it("only complete transactions survive a reopen", async () => {
    const file = tmp();
    let db: LocalDb = await openLocalDb(betterSqliteAdapter(file));
    await db.run("insert into kv values ('a', '1')");
    await expect(
      db.transaction(async (tx) => {
        await tx.run("insert into kv values ('b', '2')");
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow();
    await db.close();
    db = await openLocalDb(betterSqliteAdapter(file));
    expect(await db.all("select key from kv order by key")).toEqual([{ key: "a" }]);
    await db.close();
  });

  it("FTS5 is available for variant search with prefix and diacritic folding", async () => {
    const db = await openLocalDb(betterSqliteAdapter());
    await db.run("insert into variant_search (rowid, name, sku) values (1, 'Café Latte', 'CL-1')");
    await db.run("insert into variant_search (rowid, name, sku) values (2, 'Green Tea', 'GT-2')");
    expect(
      await db.all("select rowid from variant_search where variant_search match 'cafe*'"),
    ).toEqual([{ rowid: 1 }]);
    await db.close();
  });
});
