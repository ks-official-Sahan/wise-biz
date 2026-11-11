import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, migrate, withTenantTx } from "../src/index.ts";

import { uuid7 } from "./helpers.ts";

import type { TenantCtx, TxHandle } from "../src/index.ts";
import type pg from "pg";

// tenancy 0008 backfills gaps:* into existing system roles. The DB is migrated to 0007 first (a pre-0008 tenant
// population), seeded through wb_app, then 0008 is applied with the real migrator.
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const srcDir = join(repoRoot, "modules", "tenancy", "migrations");
const MIGRATION = "0008_gaps_role_backfill.sql";
const ctx = (tenantId: string): TenantCtx => ({ tenantId, requestId: "t" });

let tmp: string;
let migrationsDir: string;
let db: Awaited<ReturnType<typeof testDatabase>>;
let app: pg.Pool;
let migrator: pg.Pool;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "tenancy-0008-"));
  migrationsDir = join(tmp, "migrations");
  await mkdir(migrationsDir);
  // Only 0001..0007 at first. copyFile keeps the bytes (and so the checksums) identical to the repo files.
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

const SYSTEM_ROLES = [
  "owner",
  "manager",
  "supervisor",
  "cashier",
  "inventory_clerk",
  "accountant",
] as const;

async function newTenant(): Promise<string> {
  const id = uuid7();
  await withTenantTx(app, ctx(id), (tx) =>
    tx.query("insert into tenancy.tenants (tenant_id, name) values ($1, 'T')", [id]),
  );
  return id;
}

/** Inserts a role and its grants in ONE statement each, through wb_app under the tenant's context. */
async function seedRole(
  tenantId: string,
  name: string,
  isSystem: boolean,
  grants: readonly string[],
): Promise<string> {
  return withTenantTx(app, ctx(tenantId), async (tx: TxHandle) => {
    const r = await tx.query<{ id: string }>(
      "insert into tenancy.roles (tenant_id, name, is_system) values ($1, $2, $3) returning id",
      [tenantId, name, isSystem],
    );
    const roleId = r.rows[0]?.id ?? "";
    if (grants.length > 0) {
      await tx.query(
        "insert into tenancy.role_permissions (tenant_id, role_id, permission) select $1, $2, unnest($3::text[])",
        [tenantId, roleId, [...grants]],
      );
    }
    return roleId;
  });
}

/** One tenant with all six system roles; `legacy` holds the grants each system role had before 455f8c1. */
async function seedSystemRoles(
  tenantId: string,
  legacy: Partial<Record<(typeof SYSTEM_ROLES)[number], string[]>>,
) {
  for (const role of SYSTEM_ROLES) await seedRole(tenantId, role, true, legacy[role] ?? []);
}

const version = (tenantId: string): Promise<number> =>
  withTenantTx(app, ctx(tenantId), async (tx) => {
    const r = await tx.query<{ v: number }>(
      "select permissions_version v from tenancy.tenants where tenant_id = $1",
      [tenantId],
    );
    return r.rows[0]?.v ?? -1;
  });

/** "role:permission" for every grant of a tenant, sorted in JS (no collation dependence). */
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

describe("tenancy 0008: gaps grants backfill", () => {
  let A: string;
  let B: string;
  let C: string;
  let auditorId: string;
  let auditorBefore: { id: string; permission: string }[];
  let versions: { A: number; B: number; C: number };

  beforeAll(async () => {
    A = await newTenant();
    B = await newTenant();
    C = await newTenant();
    // A: pre-455f8c1 system roles (counts grants already present, as after 0007) plus a custom role that the owner
    // granted gaps:read to by hand.
    await seedSystemRoles(A, {
      manager: ["counts:read", "counts:write", "counts:approve", "inventory:read"],
      supervisor: ["sales:read"],
      cashier: ["sales:sell"],
      inventory_clerk: ["counts:read", "counts:write", "inventory:read"],
      accountant: ["counts:read", "inventory:read"],
    });
    auditorId = await seedRole(A, "auditor", false, ["gaps:read", "sales:read"]);
    // B: a different legacy shape, to show the backfill keeps existing grants and does not duplicate them.
    await seedSystemRoles(B, {
      manager: ["catalog:read", "gaps:resolve"],
      accountant: ["pricing:read"],
    });
    // C: no system roles at all, only a custom role that already holds gaps:resolve.
    await seedRole(C, "floor_lead", false, ["gaps:resolve"]);

    auditorBefore = await withTenantTx(app, ctx(A), async (tx) => {
      const r = await tx.query<{ id: string; permission: string }>(
        "select id, permission from tenancy.role_permissions where tenant_id = $1 and role_id = $2 order by permission",
        [A, auditorId],
      );
      return r.rows;
    });
    versions = { A: await version(A), B: await version(B), C: await version(C) };
  });

  it("applies 0008 once: existing system roles gain exactly the defaults, nothing else changes", async () => {
    await copyFile(join(srcDir, MIGRATION), join(migrationsDir, MIGRATION));
    const applied = await migrate(db.url("migrator"), [{ module: "tenancy", dir: migrationsDir }]);
    expect(applied).toEqual([{ module: "tenancy", version: 8, name: "gaps_role_backfill" }]);

    expect(await grantsOf(A)).toEqual(
      [
        "accountant:counts:read",
        "accountant:gaps:read",
        "accountant:inventory:read",
        "auditor:gaps:read",
        "auditor:sales:read",
        "cashier:sales:sell",
        "inventory_clerk:counts:read",
        "inventory_clerk:counts:write",
        "inventory_clerk:gaps:read",
        "inventory_clerk:gaps:write",
        "inventory_clerk:inventory:read",
        "manager:counts:approve",
        "manager:counts:read",
        "manager:counts:write",
        "manager:gaps:read",
        "manager:gaps:resolve",
        "manager:gaps:write",
        "manager:inventory:read",
        "supervisor:sales:read",
      ].sort(),
    );
    // B: the legacy catalog/pricing grants and the pre-existing gaps:resolve survive; gaps:resolve is not duplicated.
    expect(await grantsOf(B)).toEqual(
      [
        "accountant:gaps:read",
        "accountant:pricing:read",
        "inventory_clerk:gaps:read",
        "inventory_clerk:gaps:write",
        "manager:catalog:read",
        "manager:gaps:read",
        "manager:gaps:resolve",
        "manager:gaps:write",
      ].sort(),
    );
  });

  it("the custom role is untouched (same ids and grants), and owner/supervisor/cashier got no gaps grants", async () => {
    const after = await withTenantTx(app, ctx(A), async (tx) => {
      const r = await tx.query<{ id: string; permission: string }>(
        "select id, permission from tenancy.role_permissions where tenant_id = $1 and role_id = $2 order by permission",
        [A, auditorId],
      );
      return r.rows;
    });
    expect(after).toEqual(auditorBefore);
    const all = await grantsOf(A);
    expect(all.filter((g) => /^(owner|supervisor|cashier):gaps:/.test(g))).toEqual([]);
  });

  it("bumps permissions_version once for each tenant that gained grants, and not for a tenant that did not", async () => {
    expect(await version(A)).toBe(versions.A + 1);
    expect(await version(B)).toBe(versions.B + 1);
    expect(await version(C)).toBe(versions.C);
  });

  it("a second run is a no-op: no new rows, no version bump (migrate() and the raw SQL both)", async () => {
    const rowsBefore = await grantsOf(A);
    const verA = await version(A);
    const verB = await version(B);

    expect(await migrate(db.url("migrator"), [{ module: "tenancy", dir: migrationsDir }])).toEqual(
      [],
    );

    const sql = await readFile(join(srcDir, MIGRATION), "utf8");
    const client = await migrator.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect(await grantsOf(A)).toEqual(rowsBefore);
    expect(await version(A)).toBe(verA);
    expect(await version(B)).toBe(verB);
  });

  it("keeps tenant scope: transient policy is gone, RLS still forced, no tenant context sees nothing", async () => {
    const policies = await migrator.query<{ n: number }>(
      "select count(*)::int n from pg_policies where policyname = 'backfill_tenant_ids'",
    );
    expect(policies.rows[0]?.n).toBe(0);

    const flags = await migrator.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'tenancy.tenants'::regclass",
    );
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    // The migrator no longer sees tenants without a context (FORCE RLS), and wb_app sees no rows with no context.
    const migratorSees = await migrator.query<{ n: number }>(
      "select count(*)::int n from tenancy.tenants",
    );
    expect(migratorSees.rows[0]?.n).toBe(0);
    const appSees = await app.query<{ n: number }>(
      "select count(*)::int n from tenancy.role_permissions",
    );
    expect(appSees.rows[0]?.n).toBe(0);

    // Inside A's context only A's rows are visible, including the new gaps grants.
    const seenByA = await withTenantTx(app, ctx(A), (tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int n from tenancy.role_permissions where permission like 'gaps:%'",
      ),
    );
    const crossRead = await withTenantTx(app, ctx(A), (tx) =>
      tx.query<{ n: number }>(
        "select count(*)::int n from tenancy.role_permissions where tenant_id = $1",
        [B],
      ),
    );
    // manager 3 + inventory_clerk 2 + accountant 1 + the custom role's gaps:read 1.
    expect(seenByA.rows[0]?.n).toBe(7);
    expect(crossRead.rows[0]?.n).toBe(0);
  });
});
