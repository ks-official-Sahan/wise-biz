import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, migrate, withTenantTx } from "../src/index.ts";

import { uuid7 } from "./helpers.ts";

import type { TenantCtx } from "../src/index.ts";
import type pg from "pg";

// tenancy 0009 backfills support:* into existing system roles. The DB is migrated to 0008 first (a pre-0009 tenant
// population), seeded through wb_app, then 0009 is applied with the real migrator.
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const srcDir = join(repoRoot, "modules", "tenancy", "migrations");
const MIGRATION = "0009_support_role_backfill.sql";
const ctx = (tenantId: string): TenantCtx => ({ tenantId, requestId: "t" });

const SYSTEM_ROLES = [
  "owner",
  "manager",
  "supervisor",
  "cashier",
  "inventory_clerk",
  "accountant",
] as const;

let tmp: string;
let migrationsDir: string;
let db: Awaited<ReturnType<typeof testDatabase>>;
let app: pg.Pool;
let migrator: pg.Pool;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "tenancy-0009-"));
  migrationsDir = join(tmp, "migrations");
  await mkdir(migrationsDir);
  // Only 0001..0008 first. copyFile keeps the bytes (and so the checksums) identical to the repo files.
  const before = (await readdir(srcDir)).filter((f) => f.endsWith(".sql") && f < MIGRATION);
  for (const f of before) await copyFile(join(srcDir, f), join(migrationsDir, f));

  db = await testDatabase();
  await migrate(db.url("migrator"), [{ module: "tenancy", dir: migrationsDir }]);
  app = createPool(db.url("app"));
  migrator = createPool(db.url("migrator"));
});

afterAll(async () => {
  await Promise.all([app.end(), migrator.end()]);
  await db.drop();
  await rm(tmp, { recursive: true, force: true });
});

async function newTenantWithSystemRoles(): Promise<string> {
  const id = uuid7();
  await withTenantTx(app, ctx(id), async (tx) => {
    await tx.query("insert into tenancy.tenants (tenant_id, name) values ($1, 'T')", [id]);
    for (const name of SYSTEM_ROLES) {
      await tx.query(
        "insert into tenancy.roles (tenant_id, name, is_system) values ($1, $2, true)",
        [id, name],
      );
    }
  });
  return id;
}

const grantsOf = (tenantId: string): Promise<string[]> =>
  withTenantTx(app, ctx(tenantId), async (tx) => {
    const r = await tx.query<{ name: string; permission: string }>(
      `select r.name, rp.permission from tenancy.role_permissions rp
       join tenancy.roles r on r.tenant_id = rp.tenant_id and r.id = rp.role_id
       where rp.tenant_id = $1`,
      [tenantId],
    );
    return r.rows.map((x) => `${x.name}:${x.permission}`).sort();
  });

const version = (tenantId: string): Promise<number> =>
  withTenantTx(app, ctx(tenantId), async (tx) => {
    const r = await tx.query<{ v: number }>(
      "select permissions_version v from tenancy.tenants where tenant_id = $1",
      [tenantId],
    );
    return r.rows[0]?.v ?? -1;
  });

describe("tenancy 0009: support grants backfill", () => {
  let A: string;
  let C: string;
  let versions: { A: number; C: number };

  beforeAll(async () => {
    A = await newTenantWithSystemRoles();
    C = await newTenantWithSystemRoles();
    // C is pre-seeded with an exact support grant by hand: the backfill must not duplicate it.
    await withTenantTx(app, ctx(C), (tx) =>
      tx.query(
        `insert into tenancy.role_permissions (tenant_id, role_id, permission)
         select r.tenant_id, r.id, 'support:read' from tenancy.roles r
          where r.tenant_id = $1 and r.name = 'manager'`,
        [C],
      ),
    );
    versions = { A: await version(A), C: await version(C) };
  });

  it("applies 0009 once: every system role except owner gains support:create and support:read", async () => {
    // The tmp dir holds only 0001..0008 until now: bring in 0009 and apply it with the real migrator.
    await copyFile(join(srcDir, MIGRATION), join(migrationsDir, MIGRATION));
    const ran = await migrate(db.url("migrator"), [{ module: "tenancy", dir: migrationsDir }]);
    expect(ran).toEqual([{ module: "tenancy", version: 9, name: "support_role_backfill" }]);

    const expected = ["manager", "supervisor", "cashier", "inventory_clerk", "accountant"].flatMap(
      (role) => [`${role}:support:create`, `${role}:support:read`],
    );
    expect((await grantsOf(A)).filter((g) => g.includes(":support:"))).toEqual(expected.sort());
    expect((await grantsOf(A)).filter((g) => g.startsWith("owner:"))).toEqual([]);
  });

  it("a tenant that already had a grant gets it once, and the permissions version moves once", async () => {
    const support = (await grantsOf(C)).filter((g) => g.startsWith("manager:support:"));
    expect(support).toEqual(["manager:support:create", "manager:support:read"]);
    expect(await version(A)).toBe(versions.A + 1);
    expect(await version(C)).toBe(versions.C + 1);
  });

  it("re-running the statement adds nothing and bumps nothing", async () => {
    const before = await grantsOf(A);
    const verA = await version(A);
    const sql = await readFile(join(srcDir, MIGRATION), "utf8");
    const client = await migrator.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await grantsOf(A)).toEqual(before);
    expect(await version(A)).toBe(verA);
  });
});
