import { mkdtemp, writeFile, mkdir, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testDatabase } from "@wise-biz/testing/containers";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { MIGRATE_LOCK_KEY, listMigrations, loadRegistry, migrate } from "../src/index.ts";

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

describe("migrate: no-transaction files", () => {
  it("runs CREATE INDEX CONCURRENTLY outside a transaction and records it", async () => {
    const db = await testDatabase();
    const dir = await mkdtemp(join(tmpdir(), "wbmig-"));
    try {
      await writeFile(join(dir, "0001_t.sql"), "create table t_nt (a int);");
      await writeFile(
        join(dir, "0002_idx.sql"),
        "-- wb:no-transaction\nCREATE INDEX CONCURRENTLY t_nt_a_idx ON t_nt (a);\n",
      );
      const res = await migrate(db.url("migrator"), [{ module: "m", dir }]);
      expect(res.map((r) => r.name)).toEqual(["t", "idx"]);
      expect(await count(db.url("migrator"))).toBe(2);
      const c = new pg.Client({ connectionString: db.url("migrator") });
      await c.connect();
      const idx = await c.query(
        "select indisvalid from pg_index where indexrelid = 't_nt_a_idx'::regclass",
      );
      await c.end();
      expect(idx.rows).toEqual([{ indisvalid: true }]);
      expect(await migrate(db.url("migrator"), [{ module: "m", dir }])).toEqual([]);
    } finally {
      await db.drop();
    }
  });

  it("rejects a no-transaction file with several statements; nothing recorded", async () => {
    const db = await testDatabase();
    const dir = await mkdtemp(join(tmpdir(), "wbmig-"));
    try {
      await writeFile(join(dir, "0001_two.sql"), "-- wb:no-transaction\nselect 1; select 2;\n");
      await expect(migrate(db.url("migrator"), [{ module: "m", dir }])).rejects.toThrow(
        /exactly one statement/,
      );
      await migrate(db.url("migrator"), []);
      expect(await count(db.url("migrator"))).toBe(0);
    } finally {
      await db.drop();
    }
  });
});

describe("migrate: safety", () => {
  it("rejects bad module names", async () => {
    const db = await testDatabase();
    try {
      for (const module of ["../x", "Bad", "a/b", "a-b", "", "1a"]) {
        await expect(migrate(db.url("migrator"), [{ module, dir: tmpdir() }])).rejects.toThrow(
          /invalid module name/,
        );
      }
    } finally {
      await db.drop();
    }
  });

  it("throws when an applied migration file was removed or renamed", async () => {
    const db = await testDatabase();
    const dir = await mkdtemp(join(tmpdir(), "wbmig-"));
    try {
      await writeFile(join(dir, "0001_a.sql"), "select 1;");
      await writeFile(join(dir, "0002_b.sql"), "select 1;");
      await migrate(db.url("migrator"), [{ module: "m", dir }]);
      await rm(join(dir, "0002_b.sql"));
      await expect(migrate(db.url("migrator"), [{ module: "m", dir }])).rejects.toThrow(
        /applied migration .*missing/,
      );
    } finally {
      await db.drop();
    }
  });

  it("times out waiting for the advisory lock instead of hanging", async () => {
    const db = await testDatabase();
    const holder = new pg.Client({ connectionString: db.url("migrator") });
    await holder.connect();
    try {
      await holder.query("select pg_advisory_lock($1)", [MIGRATE_LOCK_KEY.toString()]);
      const t0 = Date.now();
      await expect(
        migrate(db.url("migrator"), [fixture("good")], { lockTimeoutMs: 400 }),
      ).rejects.toThrow(/advisory lock/);
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      await holder.end();
      await db.drop();
    }
  });
});

describe("loadRegistry", () => {
  it("rejects bad names and dirs resolving outside <root>/modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbreg-"));
    await mkdir(join(root, "modules"));
    const reg = async (modules: string[]) =>
      writeFile(join(root, "modules", "registry.json"), JSON.stringify({ modules }));
    for (const bad of ["../x", "Up", "a/b", "a-b"]) {
      await reg([bad]);
      await expect(loadRegistry(root)).rejects.toThrow(/invalid module name/);
    }
    const outside = await mkdtemp(join(tmpdir(), "wbout-"));
    await mkdir(join(root, "modules", "evil"));
    // "junction" works on Windows without admin/Developer Mode; ignored on POSIX.
    await symlink(outside, join(root, "modules", "evil", "migrations"), "junction");
    await reg(["evil"]);
    await expect(loadRegistry(root)).rejects.toThrow(/outside/);
    // a real dir inside is fine
    await mkdir(join(root, "modules", "ok", "migrations"), { recursive: true });
    await reg(["ok"]);
    expect((await loadRegistry(root))[0]?.dir).toBe(
      join(await realpath(root), "modules", "ok", "migrations"),
    );
  });

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
