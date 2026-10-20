import { eq } from "drizzle-orm";
import { pgSchema, text, uuid } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, findTablesWithoutRls, rlsSql, withTenantTx } from "../src/index.ts";

import { fixture, migratedDb, uuid7 } from "./helpers.ts";

const good = pgSchema("good");
const items = good.table("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
});

const A = uuid7();
const B = uuid7();
const ctx = (tenantId: string) => ({ tenantId, requestId: "r" });
let pool: pg.Pool;
let migrator: pg.Client;
let drop: () => Promise<void>;
let badDrop: () => Promise<void>;
let badClient: pg.Client;

beforeAll(async () => {
  const db = await migratedDb([fixture("good")]);
  drop = () => db.drop();
  pool = createPool(db.url("app"));
  migrator = new pg.Client({ connectionString: db.url("migrator") });
  await migrator.connect();
  await withTenantTx(pool, ctx(A), (tx) =>
    tx.query("insert into good.items (tenant_id, name) values ($1, 'a1')", [A]),
  );
  await withTenantTx(pool, ctx(B), (tx) =>
    tx.query("insert into good.items (tenant_id, name) values ($1, 'b1')", [B]),
  );

  const bad = await migratedDb([fixture("bad")]);
  badDrop = () => bad.drop();
  badClient = new pg.Client({ connectionString: bad.url("migrator") });
  await badClient.connect();
});
afterAll(async () => {
  await pool.end();
  await migrator.end();
  await badClient.end();
  await drop();
  await badDrop();
});

describe("RLS isolation", () => {
  it("drizzle: tenant A sees only A, cannot update/delete B", async () => {
    const rows = await withTenantTx(pool, ctx(A), (tx) => tx.db.select().from(items));
    expect(rows.map((r) => r.name)).toEqual(["a1"]);
    await withTenantTx(pool, ctx(A), async (tx) => {
      await tx.db.update(items).set({ name: "hacked" }).where(eq(items.name, "b1"));
      await tx.db.delete(items).where(eq(items.name, "b1"));
    });
    const b = await withTenantTx(pool, ctx(B), (tx) => tx.db.select().from(items));
    expect(b.map((r) => r.name)).toEqual(["b1"]);
  });

  it("raw SQL: update/delete across tenants affects zero rows", async () => {
    const u = await withTenantTx(pool, ctx(A), (tx) =>
      tx.query("update good.items set name = 'x' where tenant_id = $1", [B]),
    );
    const d = await withTenantTx(pool, ctx(A), (tx) =>
      tx.query("delete from good.items where tenant_id = $1", [B]),
    );
    expect([u.rowCount, d.rowCount]).toEqual([0, 0]);
  });

  it("WITH CHECK rejects inserting another tenant's row", async () => {
    await expect(
      withTenantTx(pool, ctx(A), (tx) =>
        tx.query("insert into good.items (tenant_id, name) values ($1, 'evil')", [B]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("no tenant setting -> zero rows, writes rejected", async () => {
    expect((await pool.query("select * from good.items")).rowCount).toBe(0);
    await expect(
      pool.query("insert into good.items (tenant_id, name) values ($1, 'z')", [A]),
    ).rejects.toThrow(/row-level security/);
  });

  it("wb_app cannot disable RLS or alter the table", async () => {
    await expect(pool.query("alter table good.items disable row level security")).rejects.toThrow(
      /must be owner/,
    );
    await expect(pool.query("alter table good.items no force row level security")).rejects.toThrow(
      /must be owner/,
    );
    await expect(pool.query("drop policy tenant_isolation on good.items")).rejects.toThrow(
      /must be owner/,
    );
  });
});

describe("rlsSql", () => {
  it("quotes identifiers and rejects bad names", () => {
    expect(rlsSql("s", "t", { tenantColumn: "org_id" })).toContain(
      `"org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid`,
    );
    expect(() => rlsSql("s; drop", "t")).toThrow(/invalid/);
    expect(() => rlsSql("s", "T")).toThrow(/invalid/);
    expect(() => rlsSql("s", "t", { tenantColumn: 'a"b' })).toThrow(/invalid/);
  });
});

describe("findTablesWithoutRls", () => {
  it("passes the clean fixture", async () => {
    expect(await findTablesWithoutRls(migrator, ["good"])).toEqual([]);
  });
  it("flags tables lacking RLS, force or policy", async () => {
    expect(await findTablesWithoutRls(badClient, ["bad"])).toEqual(["bad.half", "bad.leaky"]);
  });
  it("is empty for no schemas", async () => {
    expect(await findTablesWithoutRls(badClient, [])).toEqual([]);
  });
});
