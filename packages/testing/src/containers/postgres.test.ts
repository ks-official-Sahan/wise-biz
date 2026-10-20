import { randomBytes } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, inject, it } from "vitest";

import { testDatabase } from "./global-setup.ts";
import { attachPostgres } from "./postgres.ts";

const { host, port } = inject("wbPg");
const harness = attachPostgres(host, port);
const made: string[] = [];

async function clone(): Promise<string> {
  const name = `t_${randomBytes(6).toString("hex")}`;
  await harness.createDatabase(name);
  made.push(name);
  return name;
}

async function query<T extends pg.QueryResultRow>(
  db: string,
  role: "admin" | "migrator" | "app",
  sql: string,
): Promise<T[]> {
  const c = new pg.Client({ connectionString: harness.url(db, role) });
  await c.connect();
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
}

afterAll(async () => {
  await Promise.all(made.map((n) => harness.dropDatabase(n)));
});

describe("postgres harness", () => {
  it("wb_app is NOSUPERUSER NOBYPASSRLS", async () => {
    const rows = await query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "postgres",
      "admin",
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'wb_app'",
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  it("clones carry extensions", async () => {
    const db = await clone();
    const rows = await query<{ extname: string }>(db, "app", "SELECT extname FROM pg_extension");
    const names = rows.map((r) => r.extname);
    for (const e of ["pgcrypto", "pg_trgm", "vector", "pg_stat_statements"]) {
      expect(names).toContain(e);
    }
  });

  it("wb_app cannot CREATE TABLE in public; migrator can; app gets DML on migrator tables", async () => {
    const db = await clone();
    await expect(query(db, "app", "CREATE TABLE nope (id int)")).rejects.toThrow(
      /permission denied/,
    );
    await query(db, "migrator", "CREATE TABLE ok (id int)");
    await query(db, "app", "INSERT INTO ok VALUES (1)");
    expect(await query(db, "app", "SELECT id FROM ok")).toEqual([{ id: 1 }]);
  });

  it("clones are isolated", async () => {
    const a = await clone();
    const b = await clone();
    await query(a, "migrator", "CREATE TABLE only_a (id int)");
    const rows = await query<{ t: string | null }>(
      b,
      "admin",
      "SELECT to_regclass('only_a')::text AS t",
    );
    expect(rows[0]?.t).toBeNull();
  });

  it("creates 5 databases concurrently", async () => {
    const names = Array.from({ length: 5 }, () => `t_${randomBytes(6).toString("hex")}`);
    made.push(...names);
    await Promise.all(names.map((n) => harness.createDatabase(n)));
    const rows = await query<{ n: string }>(
      "postgres",
      "admin",
      `SELECT datname AS n FROM pg_database WHERE datname = ANY('{${names.join(",")}}')`,
    );
    expect(rows).toHaveLength(5);
  });

  it("rejects invalid names", async () => {
    await expect(harness.createDatabase('x"; DROP DATABASE wb_base; --')).rejects.toThrow(
      /invalid database name/,
    );
    await expect(harness.dropDatabase("Bad-Name")).rejects.toThrow(/invalid database name/);
  });

  it("testDatabase creates and drops", async () => {
    const db = await testDatabase();
    expect(db.name).toMatch(/^t_[0-9a-f]{16}$/);
    expect(await query(db.name, "app", "SELECT 1 AS one")).toEqual([{ one: 1 }]);
    expect(db.url("migrator")).toContain("wb_migrator");
    await db.drop();
    const rows = await query(
      "postgres",
      "admin",
      `SELECT 1 FROM pg_database WHERE datname = '${db.name}'`,
    );
    expect(rows).toHaveLength(0);
  });
});
