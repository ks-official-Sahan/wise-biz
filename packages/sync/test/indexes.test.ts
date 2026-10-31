import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createIndexes, ftsQuery } from "../src/indexes.ts";
import { applyChanges, applySnapshot } from "../src/pull.ts";
import { openLocalDb } from "../src/schema/migrations.ts";

import { betterSqliteAdapter } from "./support/better-sqlite.ts";

import type { PullChange } from "../src/pull.ts";
import type { LocalDb } from "../src/storage/local-db.ts";

const base = join(import.meta.dirname, "..", "node_modules", ".cache", "wb-sync-test");
const dirs: string[] = [];
const dbs: LocalDb[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const newDb = async (file?: string) => {
  const db = await openLocalDb(betterSqliteAdapter(file));
  dbs.push(db);
  return db;
};

const change = (
  entity: string,
  entityId: string,
  payload: unknown,
  op: "upsert" | "delete" = "upsert",
): PullChange => ({ entity, entityId, op, version: 0, payload, changedAt: "t" });

describe("ftsQuery", () => {
  it("turns free text into quoted tokens with a prefix on the last word", () => {
    expect(ftsQuery("green te")).toBe('"green" "te"*');
    expect(ftsQuery("  Café  ")).toBe('"Café"*');
    expect(ftsQuery("coke 0.5l")).toBe('"coke" "0" "5l"*');
  });

  it("never lets user input become FTS syntax", () => {
    expect(ftsQuery('" OR 1 --')).toBe('"OR" "1"*');
    expect(ftsQuery("tea* NEAR(a b) col:x -y")).toBe('"tea" "NEAR" "a" "b" "col" "x" "y"*');
    expect(ftsQuery('"""')).toBeUndefined();
    expect(ftsQuery("")).toBeUndefined();
    expect(ftsQuery("a b c d e f g h i j")).toBe('"a" "b" "c" "d" "e" "f" "g" "h"*');
  });
});

describe("indexes", () => {
  it("maps barcodes to variants, replacing a variant's codes as a set", async () => {
    const db = await newDb();
    const idx = createIndexes(db);
    idx.apply("catalog", [change("barcodes", "v1", { variantId: "v1", codes: ["111", "222"] })]);
    expect(idx.variantForBarcode("111")).toBe("v1");
    expect(idx.variantForBarcode("222")).toBe("v1");
    expect(idx.barcodeCount).toBe(2);
    idx.apply("catalog", [change("barcodes", "v1", { variantId: "v1", codes: ["222", "333"] })]);
    expect(idx.variantForBarcode("111")).toBeUndefined();
    expect(idx.variantForBarcode("333")).toBe("v1");
    // A code that moved to another variant is not removed by the old owner's update.
    idx.apply("catalog", [change("barcodes", "v2", { variantId: "v2", codes: ["333"] })]);
    idx.apply("catalog", [change("barcodes", "v1", { variantId: "v1", codes: ["222"] })]);
    expect(idx.variantForBarcode("333")).toBe("v2");
    idx.apply("catalog", [change("barcodes", "v2", null, "delete")]);
    expect(idx.variantForBarcode("333")).toBeUndefined();
    idx.apply("prices", [change("barcodes", "v9", { variantId: "v9", codes: ["9"] })]);
    idx.apply("catalog", [change("variant", "v9", { variantId: "v9" })]);
    expect(idx.variantForBarcode("9")).toBeUndefined();
  });

  it("rebuilds from the database after a snapshot", async () => {
    const db = await newDb();
    await applySnapshot(
      db,
      "catalog",
      {
        cursor: "c1",
        rows: [
          {
            entity: "barcodes",
            id: "v1",
            version: 0,
            payload: { variantId: "v1", codes: ["a", "b"] },
          },
          {
            entity: "variant",
            id: "v1",
            version: 0,
            payload: { variantId: "v1", name: "Tea", sku: "T" },
          },
        ],
      },
      0,
    );
    const idx = createIndexes(db);
    await idx.load();
    expect(idx.variantForBarcode("b")).toBe("v1");
    await idx.load();
    expect(idx.barcodeCount).toBe(2);
  });

  it("searches names and SKUs by prefix, best match first, without archived variants", async () => {
    const db = await newDb();
    await db.transaction(async (tx) => {
      await applyChanges(tx, "catalog", [
        change("variant", "v1", { variantId: "v1", name: "Green Tea 500g", sku: "GT-500" }),
        change("variant", "v2", { variantId: "v2", name: "Green Apple Juice", sku: "GJ-1" }),
        change("variant", "v3", {
          variantId: "v3",
          name: "Green Tea Old",
          sku: "GT-0",
          archived: true,
        }),
        change("variant", "v4", { variantId: "v4", name: "Café Latte", sku: "CL" }),
      ]);
    });
    const idx = createIndexes(db);
    expect((await idx.search("green t")).map((h) => h.variantId)).toEqual(["v1"]);
    expect((await idx.search("gre")).map((h) => h.variantId).sort()).toEqual(["v1", "v2"]);
    expect((await idx.search("gt-500")).map((h) => h.variantId)).toEqual(["v1"]);
    expect((await idx.search("cafe")).map((h) => h.variantId)).toEqual(["v4"]);
    expect(await idx.search("")).toEqual([]);
    expect(await idx.search("zzz")).toEqual([]);
    expect(await idx.search("gre", 1)).toHaveLength(1);
  });
});

describe("lookup budgets", () => {
  it(
    "barcode map under 0.1 ms; FTS over 100k variants under 30 ms",
    { timeout: 120_000 },
    async () => {
      mkdirSync(base, { recursive: true });
      const dir = mkdtempSync(join(base, "idx-"));
      dirs.push(dir);
      const db = await newDb(join(dir, "device.db"));
      const words = [
        "green",
        "black",
        "oolong",
        "milk",
        "sugar",
        "coffee",
        "cocoa",
        "mint",
        "ginger",
        "honey",
      ];
      const rows = [];
      for (let i = 0; i < 100_000; i++) {
        const name = `${words[i % 10] ?? ""} ${words[(i >> 3) % 10] ?? ""} ${String(i)}`;
        rows.push({
          entity: "variant",
          id: `v${String(i)}`,
          version: 0,
          payload: { variantId: `v${String(i)}`, name, sku: `S${String(i)}` },
        });
        if (i % 2 === 0) {
          rows.push({
            entity: "barcodes",
            id: `v${String(i)}`,
            version: 0,
            payload: { variantId: `v${String(i)}`, codes: [`978${String(i).padStart(9, "0")}`] },
          });
        }
      }
      const t0 = performance.now();
      await applySnapshot(db, "catalog", { cursor: "c1", rows }, 0);
      const loadMs = performance.now() - t0;
      const idx = createIndexes(db);
      await idx.load();

      const lookups = 200_000;
      const t1 = performance.now();
      let hit = 0;
      for (let i = 0; i < lookups; i++) {
        if (idx.variantForBarcode(`978${String((i * 2) % 100_000).padStart(9, "0")}`) !== undefined)
          hit++;
      }
      const perLookupMs = (performance.now() - t1) / lookups;
      expect(hit).toBe(lookups);

      const times: number[] = [];
      for (const q of ["gre", "green mi", "oolong su", "coffee 99", "hon gin", "S5000"]) {
        await idx.search(q);
        for (let r = 0; r < 10; r++) {
          const s = performance.now();
          await idx.search(q, 20);
          times.push(performance.now() - s);
        }
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
      process.stderr.write(
        `100k variants: snapshot applied in ${(loadMs / 1000).toFixed(1)} s; barcode lookup ${(perLookupMs * 1000).toFixed(2)} us; FTS p95 ${p95.toFixed(1)} ms\n`,
      );
      expect(perLookupMs).toBeLessThan(0.1);
      expect(p95).toBeLessThan(30);
    },
  );
});
