import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testDatabase } from "@wise-biz/testing/containers";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { listMigrations, loadRegistry, migrate } from "../src/index.ts";

import { fixture } from "./helpers.ts";

async function count(url: string): Promise<number> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const res = await c.query<{ n: number }>("select count(*)::int n from wb_migrations.applied");
    return res.rows[0]?.n ?? -1;
  } finally {
    await c.end();
  }
}

describe("migrate", () => {
  it("applies in order, re-run is a no-op", async () => {
    const db = await testDatabase();
    try {
      const first = await migrate(db.url("migrator"), [fixture("good")]);
      expect(first.map((a) => `${a.module}:${String(a.version)}:${a.name}`)).toEqual([
        "good:1:init",
        "good:2:children",
      ]);
      expect(await migrate(db.url("migrator"), [fixture("good")])).toEqual([]);
      expect(await count(db.url("migrator"))).toBe(2);
    } finally {
      await db.drop();
    }
  });

  it("throws on checksum mismatch of an applied file", async () => {
    const db = await testDatabase();
    const dir = await mkdtemp(join(tmpdir(), "wbmig-"));
    try {
      await writeFile(join(dir, "0001_a.sql"), "select 1;\n");
      await migrate(db.url("migrator"), [{ module: "m", dir }]);
      await writeFile(join(dir, "0001_a.sql"), "select 2;\n");
      await expect(migrate(db.url("migrator"), [{ module: "m", dir }])).rejects.toThrow(
        /checksum mismatch/,
      );
    } finally {
      await db.drop();
    }
  });

  it("throws on gaps, duplicates and bad names; failed file rolls back", async () => {
    await expect(listMigrations(fixture("gap"))).rejects.toThrow(/gap or duplicate/);
    const dir = await mkdtemp(join(tmpdir(), "wbmig-"));
    await writeFile(join(dir, "0001_a.sql"), "select 1;");
    await writeFile(join(dir, "0001_b.sql"), "select 1;");
    await expect(listMigrations({ module: "m", dir })).rejects.toThrow(/gap or duplicate/);
    const dir2 = await mkdtemp(join(tmpdir(), "wbmig-"));
    await writeFile(join(dir2, "1_x.sql"), "select 1;");
    await expect(listMigrations({ module: "m", dir: dir2 })).rejects.toThrow(
      /bad migration filename/,
    );
    expect(await listMigrations({ module: "m", dir: join(dir2, "missing") })).toEqual([]);

    const db = await testDatabase();
    const dir3 = await mkdtemp(join(tmpdir(), "wbmig-"));
    try {
      await writeFile(join(dir3, "0001_ok.sql"), "select 1;");
      await writeFile(join(dir3, "0002_broken.sql"), "create table t_half (a int); select nope;");
      await expect(migrate(db.url("migrator"), [{ module: "m", dir: dir3 }])).rejects.toThrow();
      expect(await count(db.url("migrator"))).toBe(1);
    } finally {
      await db.drop();
    }
  });

  it("two concurrent runs are safe", async () => {
    const db = await testDatabase();
    try {
      const [a, b] = await Promise.all([
        migrate(db.url("migrator"), [fixture("good")]),
        migrate(db.url("migrator"), [fixture("good")]),
      ]);
      expect(a.length + b.length).toBe(2);
      expect(await count(db.url("migrator"))).toBe(2);
    } finally {
      await db.drop();
    }
  });
});

describe("loadRegistry", () => {
  it("maps names to migration dirs and validates shape", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbreg-"));
    await mkdir(join(root, "modules"));
    await writeFile(
      join(root, "modules", "registry.json"),
      JSON.stringify({ modules: ["_template", "sales"] }),
    );
    expect(await loadRegistry(root)).toEqual([
      { module: "_template", dir: join(root, "modules", "_template", "migrations") },
      { module: "sales", dir: join(root, "modules", "sales", "migrations") },
    ]);
    await writeFile(join(root, "modules", "registry.json"), JSON.stringify({ modules: [1] }));
    await expect(loadRegistry(root)).rejects.toThrow(/expected/);
  });
});
