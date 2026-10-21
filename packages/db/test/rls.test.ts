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
let badAdmin: pg.Client;

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
  badAdmin = new pg.Client({ connectionString: bad.url("admin") });
  await badAdmin.connect();
});
afterAll(async () => {
  await pool.end();
  await migrator.end();
  await badClient.end();
  await badAdmin.end();
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

  const TENANT = `"tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid`;
  const rls = (t: string): string =>
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;`;
  const policy = (t: string, expr = TENANT): string =>
    `CREATE POLICY tenant_isolation ON ${t} USING (${expr}) WITH CHECK (${expr});`;
  const mk = async (schema: string, sql: string): Promise<void> => {
    await badClient.query(
      `CREATE SCHEMA ${schema}; GRANT USAGE ON SCHEMA ${schema} TO wb_app; ${sql}`,
    );
  };

  it("partitioned parent without RLS is flagged; partition needs its own RLS", async () => {
    await mk(
      "pt1",
      `CREATE TABLE pt1.ev (id uuid NOT NULL DEFAULT uuidv7(), tenant_id uuid NOT NULL, at timestamptz NOT NULL)
         PARTITION BY RANGE (at);
       CREATE TABLE pt1.ev_2026 PARTITION OF pt1.ev FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`,
    );
    expect(await findTablesWithoutRls(badClient, ["pt1"])).toEqual(["pt1.ev", "pt1.ev_2026"]);
    await badClient.query(`${rls("pt1.ev")} ${policy("pt1.ev")}`);
    // parent compliant, partition still bare: a direct query on the partition ignores parent policies
    expect(await findTablesWithoutRls(badClient, ["pt1"])).toEqual(["pt1.ev_2026"]);
    await badClient.query(`${rls("pt1.ev_2026")} ${policy("pt1.ev_2026")}`);
    expect(await findTablesWithoutRls(badClient, ["pt1"])).toEqual([]);
  });

  it("flags materialized views and foreign tables readable by wb_app", async () => {
    await mk(
      "mv1",
      `CREATE TABLE mv1.base (tenant_id uuid NOT NULL); ${rls("mv1.base")} ${policy("mv1.base")}
       CREATE MATERIALIZED VIEW mv1.agg AS SELECT tenant_id FROM mv1.base;
       CREATE MATERIALIZED VIEW mv1.hidden AS SELECT tenant_id FROM mv1.base;
       REVOKE ALL ON mv1.hidden FROM wb_app;`,
    );
    expect(await findTablesWithoutRls(badClient, ["mv1"])).toEqual(["mv1.agg"]);

    await badAdmin.query(
      `CREATE EXTENSION IF NOT EXISTS postgres_fdw;
       CREATE SERVER IF NOT EXISTS wb_fs FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'localhost');
       GRANT USAGE ON FOREIGN DATA WRAPPER postgres_fdw TO wb_migrator;
       GRANT USAGE ON FOREIGN SERVER wb_fs TO wb_migrator;`,
    );
    await mk("ft1", `CREATE FOREIGN TABLE ft1.remote (tenant_id uuid) SERVER wb_fs;`);
    expect(await findTablesWithoutRls(badClient, ["ft1"])).toEqual(["ft1.remote"]);
    await badClient.query("REVOKE ALL ON ft1.remote FROM wb_app");
    expect(await findTablesWithoutRls(badClient, ["ft1"])).toEqual([]);
  });

  it("flags views without security_invoker=true", async () => {
    await mk(
      "vw1",
      `CREATE TABLE vw1.base (tenant_id uuid NOT NULL); ${rls("vw1.base")} ${policy("vw1.base")}
       CREATE VIEW vw1.leaky AS SELECT * FROM vw1.base;
       CREATE VIEW vw1.safe WITH (security_invoker = true) AS SELECT * FROM vw1.base;`,
    );
    expect(await findTablesWithoutRls(badClient, ["vw1"])).toEqual(["vw1.leaky"]);
  });

  it("checks policy content: USING (true), wrong cmd, restrictive-only all fail", async () => {
    await mk(
      "pc1",
      `CREATE TABLE pc1.open_t (tenant_id uuid NOT NULL); ${rls("pc1.open_t")} ${policy("pc1.open_t", "true")}
       CREATE TABLE pc1.select_only (tenant_id uuid NOT NULL); ${rls("pc1.select_only")}
         CREATE POLICY p ON pc1.select_only FOR SELECT USING (${TENANT});
       CREATE TABLE pc1.restrictive (tenant_id uuid NOT NULL); ${rls("pc1.restrictive")}
         CREATE POLICY p ON pc1.restrictive AS RESTRICTIVE USING (${TENANT}) WITH CHECK (${TENANT});
       CREATE TABLE pc1.no_check (tenant_id uuid NOT NULL); ${rls("pc1.no_check")}
         CREATE POLICY p ON pc1.no_check USING (${TENANT});
       CREATE TABLE pc1.ok (tenant_id uuid NOT NULL); ${rls("pc1.ok")} ${policy("pc1.ok")}`,
    );
    expect(await findTablesWithoutRls(badClient, ["pc1"])).toEqual([
      "pc1.no_check",
      "pc1.open_t",
      "pc1.restrictive",
      "pc1.select_only",
    ]);
  });
});
