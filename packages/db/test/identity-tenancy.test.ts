import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPool,
  findGlobalSchemaLeaks,
  findTablesWithoutRls,
  loadGlobalSchemas,
  loadRegistry,
  migrate,
  withTenantTx,
  withUserTx,
} from "../src/index.ts";

import { fixture, migratedDb, uuid7 } from "./helpers.ts";

import type { TxHandle } from "../src/index.ts";
import type pg from "pg";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const tctx = (tenantId: string, userId?: string) => ({
  tenantId,
  ...(userId === undefined ? {} : { userId }),
  requestId: "t",
});
const uctx = (userId: string) => ({ userId, requestId: "t" });

let app: pg.Pool;
let identity: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let allSchemas: string[];
let globals: string[];

beforeAll(async () => {
  const entries = await loadRegistry(repoRoot);
  globals = await loadGlobalSchemas(repoRoot);
  allSchemas = entries.map((e) => e.module.replace(/^_/, ""));
  const db = await migratedDb(entries);
  drop = () => db.drop();
  app = createPool(db.url("app"));
  identity = createPool(db.url("identity"));
  admin = createPool(db.url("admin"));
});
afterAll(async () => {
  await Promise.all([app.end(), identity.end(), admin.end()]);
  await drop();
});

async function newTenant(name = "T"): Promise<string> {
  const id = uuid7();
  await withTenantTx(app, tctx(id), (tx) =>
    tx.query("insert into tenancy.tenants (tenant_id, name) values ($1, $2)", [id, name]),
  );
  return id;
}
const version = (tenantId: string): Promise<number> =>
  withTenantTx(app, tctx(tenantId), async (tx) => {
    const r = await tx.query<{ v: number }>(
      "select permissions_version v from tenancy.tenants where tenant_id = $1",
      [tenantId],
    );
    return r.rows[0]?.v ?? -1;
  });

describe("registry + migrations", () => {
  it("registry lists identity and tenancy in order, identity is global", () => {
    expect(allSchemas).toEqual([
      "infra",
      "audit",
      "identity",
      "tenancy",
      "devices",
      "catalog",
      "template",
    ]);
    expect(globals).toEqual(["identity"]);
  });

  it("loadGlobalSchemas validates shape and membership in modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbglob-"));
    await mkdir(join(root, "modules"));
    const reg = (o: unknown) =>
      writeFile(join(root, "modules", "registry.json"), JSON.stringify(o));
    await reg({ modules: ["a"] });
    expect(await loadGlobalSchemas(root)).toEqual([]);
    await reg({ modules: ["a"], global: ["a"] });
    expect(await loadGlobalSchemas(root)).toEqual(["a"]);
    await reg({ modules: ["a"], global: ["b"] });
    await expect(loadGlobalSchemas(root)).rejects.toThrow(/not in modules/);
    await reg({ modules: ["a"], global: "a" });
    await expect(loadGlobalSchemas(root)).rejects.toThrow(/expected/);
    await reg({ modules: ["a"], global: ["../x"] });
    await expect(loadGlobalSchemas(root)).rejects.toThrow(/invalid module name/);
  });

  it("migrations are idempotent on re-run", async () => {
    const db = await migratedDb(await loadRegistry(repoRoot));
    try {
      expect(await migrate(db.url("migrator"), await loadRegistry(repoRoot))).toEqual([]);
    } finally {
      await db.drop();
    }
  });

  it("tenancy and every other non-global schema pass the RLS lint", async () => {
    const nonGlobal = allSchemas.filter((s) => !globals.includes(s));
    expect(await findTablesWithoutRls(admin, ["tenancy"])).toEqual([]);
    expect(await findTablesWithoutRls(admin, nonGlobal)).toEqual([]);
  });
});

describe("global schema check", () => {
  it("passes for identity (no wb_app / wb_worker privileges at all)", async () => {
    expect(await findGlobalSchemaLeaks(admin, ["identity"])).toEqual([]);
  });

  it("FAILS on a global schema that grants wb_app SELECT", async () => {
    const bad = await migratedDb([fixture("leakyglobal")]);
    const c = createPool(bad.url("admin"));
    try {
      const leaks = await findGlobalSchemaLeaks(c, ["leakyglobal"]);
      expect(leaks).toContain("leakyglobal.accounts -> wb_app");
      expect(leaks).toContain("leakyglobal -> wb_app");
      expect(leaks.some((l) => l.endsWith("-> wb_worker"))).toBe(false);
    } finally {
      await c.end();
      await bad.drop();
    }
  });

  it("wb_worker privileges are caught too", async () => {
    const bad = await migratedDb([fixture("leakyglobal")]);
    const c = createPool(bad.url("admin"));
    try {
      await c.query("grant select on leakyglobal.accounts to wb_worker");
      expect(await findGlobalSchemaLeaks(c, ["leakyglobal"])).toContain(
        "leakyglobal.accounts -> wb_worker",
      );
    } finally {
      await c.end();
      await bad.drop();
    }
  });

  it("wb_app cannot read identity.users (permission denied); wb_identity can", async () => {
    await expect(app.query("select 1 from identity.users")).rejects.toThrow(/permission denied/);
    await expect(
      withTenantTx(app, tctx(uuid7()), (tx) => tx.query("select 1 from identity.sessions")),
    ).rejects.toThrow(/permission denied/);
    const id = uuid7();
    await identity.query("insert into identity.users (id, name, email) values ($1, 'A', $2)", [
      id,
      `a-${id}@x.test`,
    ]);
    const r = await identity.query("select id from identity.users where id = $1", [id]);
    expect(r.rowCount).toBe(1);
  });

  it("identity: default id is UUIDv7, email must be lowercase and unique", async () => {
    const r = await identity.query<{ id: string }>(
      "insert into identity.users (name, email) values ('B', 'b@x.test') returning id",
    );
    expect(r.rows[0]?.id[14]).toBe("7");
    await expect(
      identity.query("insert into identity.users (name, email) values ('B', 'B@x.test')"),
    ).rejects.toThrow(/check constraint/);
    await expect(
      identity.query("insert into identity.users (name, email) values ('B2', 'b@x.test')"),
    ).rejects.toThrow(/duplicate key/);
  });

  it("identity: deleting a user cascades to sessions and accounts", async () => {
    const u = uuid7();
    await identity.query("insert into identity.users (id, name, email) values ($1, 'C', $2)", [
      u,
      `c-${u}@x.test`,
    ]);
    await identity.query(
      "insert into identity.sessions (user_id, token, expires_at) values ($1, $2, now() + interval '1 hour')",
      [u, `tok-${u}`],
    );
    await identity.query(
      "insert into identity.accounts (user_id, account_id, provider_id) values ($1, $2, 'credential')",
      [u, `acct-${u}`],
    );
    await identity.query("delete from identity.users where id = $1", [u]);
    const s = await identity.query("select 1 from identity.sessions where user_id = $1", [u]);
    const a = await identity.query("select 1 from identity.accounts where user_id = $1", [u]);
    expect([s.rowCount, a.rowCount]).toEqual([0, 0]);
  });
});

describe("tenancy RLS", () => {
  it("tenant A cannot see or touch B; missing setting returns no rows", async () => {
    const a = await newTenant("A");
    const b = await newTenant("B");
    for (const t of [a, b]) {
      await withTenantTx(app, tctx(t), (tx) =>
        tx.query(
          "insert into tenancy.branches (tenant_id, name, kind, timezone, currency, tax_region) values ($1, 'main', 'store', 'UTC', 'USD', 'US')",
          [t],
        ),
      );
    }
    const seen = await withTenantTx(app, tctx(a), (tx) =>
      tx.query<{ tenant_id: string }>("select tenant_id from tenancy.branches"),
    );
    expect(seen.rows.map((r) => r.tenant_id)).toEqual([a]);
    const tenants = await withTenantTx(app, tctx(a), (tx) =>
      tx.query<{ tenant_id: string }>("select tenant_id from tenancy.tenants"),
    );
    expect(tenants.rows.map((r) => r.tenant_id)).toEqual([a]);
    // cross-tenant write rejected by WITH CHECK
    await expect(
      withTenantTx(app, tctx(a), (tx) =>
        tx.query("insert into tenancy.settings (tenant_id, key, value) values ($1, 'k', '1')", [b]),
      ),
    ).rejects.toThrow(/row-level security/);
    // no GUC at all -> zero rows
    expect((await app.query("select 1 from tenancy.branches")).rowCount).toBe(0);
    expect((await app.query("select 1 from tenancy.memberships")).rowCount).toBe(0);
  });

  it("with only app.user_id set, a user sees exactly their own memberships and active tenants", async () => {
    const me = uuid7();
    const other = uuid7();
    const t1 = await newTenant("T1");
    const t2 = await newTenant("T2");
    const t3 = await newTenant("T3-suspended-membership");
    const t4 = await newTenant("T4-not-mine");
    const add = (t: string, u: string, status = "active") =>
      withTenantTx(app, tctx(t), (tx) =>
        tx.query(
          "insert into tenancy.memberships (tenant_id, user_id, status) values ($1, $2, $3)",
          [t, u, status],
        ),
      );
    await add(t1, me);
    await add(t2, me);
    await add(t3, me, "suspended");
    await add(t4, other);
    await add(t1, other);

    const res = await withUserTx(app, uctx(me), async (tx) => {
      const m = await tx.query<{ tenant_id: string; user_id: string }>(
        "select tenant_id, user_id from tenancy.memberships",
      );
      const t = await tx.query<{ tenant_id: string }>("select tenant_id from tenancy.tenants");
      const mine = await tx.query<{ tenant_id: string; name: string }>(
        `select t.tenant_id, t.name from tenancy.memberships m
         join tenancy.tenants t on t.tenant_id = m.tenant_id
         where m.user_id = $1 and m.status = 'active' order by t.name`,
        [me],
      );
      return { m, t, mine };
    });
    expect(res.m.rows.every((r) => r.user_id === me)).toBe(true);
    expect(res.m.rows.map((r) => r.tenant_id).sort()).toEqual([t1, t2, t3].sort());
    // suspended membership: tenant not listed
    expect(res.t.rows.map((r) => r.tenant_id).sort()).toEqual([t1, t2].sort());
    expect(res.mine.rows.map((r) => r.name)).toEqual(["T1", "T2"]);

    // user-only context is read-only on tenancy: cannot write, sees no other tenant data.
    await expect(
      withUserTx(app, uctx(me), (tx) =>
        tx.query("insert into tenancy.settings (tenant_id, key, value) values ($1, 'k', '1')", [
          t1,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      (await withUserTx(app, uctx(me), (tx) => tx.query("select 1 from tenancy.roles"))).rowCount,
    ).toBe(0);
    // another user sees none of mine
    const theirs = await withUserTx(app, uctx(other), (tx) =>
      tx.query<{ tenant_id: string }>("select tenant_id from tenancy.memberships"),
    );
    expect(theirs.rows.map((r) => r.tenant_id).sort()).toEqual([t1, t4].sort());
  });

  it("with a tenant active, a user who is also a member of B sees only A rows", async () => {
    const me = uuid7();
    const a = await newTenant("A");
    const b = await newTenant("B");
    for (const t of [a, b]) {
      await withTenantTx(app, tctx(t), (tx) =>
        tx.query("insert into tenancy.memberships (tenant_id, user_id) values ($1, $2)", [t, me]),
      );
    }
    const seen = await withTenantTx(app, tctx(a, me), async (tx) => ({
      m: await tx.query<{ tenant_id: string }>("select tenant_id from tenancy.memberships"),
      t: await tx.query<{ tenant_id: string }>("select tenant_id from tenancy.tenants"),
    }));
    expect(seen.m.rows.map((r) => r.tenant_id)).toEqual([a]);
    expect(seen.t.rows.map((r) => r.tenant_id)).toEqual([a]);
    // and without a tenant the same user sees both
    const both = await withUserTx(app, uctx(me), (tx) =>
      tx.query<{ tenant_id: string }>("select tenant_id from tenancy.memberships"),
    );
    expect(both.rows.map((r) => r.tenant_id).sort()).toEqual([a, b].sort());
  });

  it("grants: column-level UPDATE only; no DELETE/TRUNCATE except grant tables", async () => {
    const t = await newTenant("orig");
    await withTenantTx(app, tctx(t), async (tx) => {
      await tx.query("update tenancy.tenants set name = 'renamed' where tenant_id = $1", [t]);
    });
    await expect(
      withTenantTx(app, tctx(t), (tx) =>
        tx.query("update tenancy.tenants set created_at = now() where tenant_id = $1", [t]),
      ),
    ).rejects.toThrow(/permission denied/);
    for (const col of ["status = 'suspended'", "permissions_version = 99"]) {
      await expect(
        withTenantTx(app, tctx(t), (tx) =>
          tx.query(`update tenancy.tenants set ${col} where tenant_id = $1`, [t]),
        ),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      withTenantTx(app, tctx(t), (tx) => tx.query("delete from tenancy.tenants")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenantTx(app, tctx(t), (tx) => tx.query("delete from tenancy.roles")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      withTenantTx(app, tctx(t), (tx) => tx.query("update tenancy.roles set name = 'x'")),
    ).rejects.toThrow(/permission denied/);
  });

  it("constraints: platform_admin role name, composite FKs, currency format", async () => {
    const t = await newTenant();
    const u = await newTenant();
    await expect(
      withTenantTx(app, tctx(t), (tx) =>
        tx.query("insert into tenancy.roles (tenant_id, name) values ($1, 'platform_admin')", [t]),
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      withTenantTx(app, tctx(t), (tx) =>
        tx.query(
          "insert into tenancy.branches (tenant_id, name, kind, timezone, currency, tax_region) values ($1, 'x', 'store', 'UTC', 'usd', 'US')",
          [t],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
    // role_permissions: unique per role+permission, conditions must be a JSON object; memberships: non-empty branch_ids
    const r1 = await withTenantTx(app, tctx(t), (tx) =>
      tx.query<{ id: string }>(
        "insert into tenancy.roles (tenant_id, name) values ($1, 'r2') returning id",
        [t],
      ),
    );
    const grant = (cond: string) =>
      withTenantTx(app, tctx(t), (tx) =>
        tx.query(
          "insert into tenancy.role_permissions (tenant_id, role_id, permission, conditions) values ($1, $2, 'a:b', $3::jsonb)",
          [t, r1.rows[0]?.id, cond],
        ),
      );
    await expect(grant("[1]")).rejects.toThrow(/check constraint/);
    await grant('{"own": true}');
    await expect(grant('{"own": false}')).rejects.toThrow(/duplicate key/);
    await expect(
      withTenantTx(app, tctx(t), (tx) =>
        tx.query(
          "insert into tenancy.memberships (tenant_id, user_id, branch_ids) values ($1, $2, '{}')",
          [t, uuid7()],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
    // a role of tenant U cannot be granted permissions from tenant T (composite FK; admin sees both tenants)
    const role = await admin.query<{ id: string }>(
      "insert into tenancy.roles (tenant_id, name) values ($1, 'r1') returning id",
      [u],
    );
    await expect(
      admin.query(
        "insert into tenancy.role_permissions (tenant_id, role_id, permission) values ($1, $2, 'x:y')",
        [t, role.rows[0]?.id],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("permissions_version trigger", () => {
  it("bumps once per statement on role_permissions changes only; membership changes do not bump", async () => {
    const t = await newTenant();
    const user = uuid7();
    expect(await version(t)).toBe(1);

    const run = <T>(fn: (tx: TxHandle) => Promise<T>) => withTenantTx(app, tctx(t), fn);
    const role = await run((tx) =>
      tx.query<{ id: string }>(
        "insert into tenancy.roles (tenant_id, name) values ($1, 'cashier') returning id",
        [t],
      ),
    );
    const roleId = role.rows[0]?.id;
    expect(await version(t)).toBe(1); // roles alone do not matter until granted

    await run((tx) =>
      tx.query(
        "insert into tenancy.role_permissions (tenant_id, role_id, permission) values ($1, $2, 'a:read'), ($1, $2, 'a:write'), ($1, $2, 'b:read')",
        [t, roleId],
      ),
    );
    expect(await version(t)).toBe(2); // 3 rows, ONE bump (SECURITY DEFINER: wb_app has no UPDATE on the column)

    // memberships / membership_roles are read fresh per request: no bump
    const mem = await run((tx) =>
      tx.query<{ id: string }>(
        "insert into tenancy.memberships (tenant_id, user_id) values ($1, $2) returning id",
        [t, user],
      ),
    );
    const memId = mem.rows[0]?.id;
    await run((tx) =>
      tx.query(
        "insert into tenancy.membership_roles (tenant_id, membership_id, role_id) values ($1, $2, $3)",
        [t, memId, roleId],
      ),
    );
    await run((tx) =>
      tx.query("update tenancy.memberships set status = 'suspended' where tenant_id = $1", [t]),
    );
    await run((tx) => tx.query("delete from tenancy.membership_roles where tenant_id = $1", [t]));
    expect(await version(t)).toBe(2);

    await run((tx) =>
      tx.query(
        "delete from tenancy.role_permissions where tenant_id = $1 and permission = 'b:read'",
        [t],
      ),
    );
    expect(await version(t)).toBe(3);

    // a statement that matches zero rows does not bump
    await run((tx) =>
      tx.query(
        "delete from tenancy.role_permissions where tenant_id = $1 and permission = 'nope'",
        [t],
      ),
    );
    expect(await version(t)).toBe(3);
  });

  it("trigger function is SECURITY DEFINER, pinned search_path, not executable by PUBLIC", async () => {
    const r = await admin.query<{ prosecdef: boolean; cfg: string[]; owner: string; pub: boolean }>(
      `select prosecdef, proconfig as cfg, pg_get_userbyid(proowner) as owner,
              has_function_privilege('wb_identity', oid, 'EXECUTE') as pub
       from pg_proc where proname = 'bump_permissions_version'`,
    );
    expect(r.rows[0]).toEqual({
      prosecdef: true,
      cfg: ["search_path=pg_catalog, tenancy"],
      owner: "wb_migrator",
      pub: false,
    });
  });

  it("only bumps the caller's tenant", async () => {
    const a = await newTenant();
    const b = await newTenant();
    const r = await withTenantTx(app, tctx(a), (tx) =>
      tx.query<{ id: string }>(
        "insert into tenancy.roles (tenant_id, name) values ($1, 'x') returning id",
        [a],
      ),
    );
    await withTenantTx(app, tctx(a), (tx) =>
      tx.query(
        "insert into tenancy.role_permissions (tenant_id, role_id, permission) values ($1, $2, 'p:q')",
        [a, r.rows[0]?.id],
      ),
    );
    expect(await version(a)).toBe(2);
    expect(await version(b)).toBe(1);
  });

  it("a grant change outside the tenant context fails instead of silently skipping the bump", async () => {
    const a = await newTenant();
    const r = await withTenantTx(app, tctx(a), (tx) =>
      tx.query<{ id: string }>(
        "insert into tenancy.roles (tenant_id, name) values ($1, 'y') returning id",
        [a],
      ),
    );
    // Superuser bypasses RLS for its own statement, but the SECURITY DEFINER bump runs as wb_migrator under FORCE RLS.
    await expect(
      admin.query(
        "insert into tenancy.role_permissions (tenant_id, role_id, permission) values ($1, $2, 'p:r')",
        [a, r.rows[0]?.id],
      ),
    ).rejects.toThrow(/outside the tenant context/);
    expect(await version(a)).toBe(1);
  });
});

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

describe("EXPLAIN as wb_app on seeded memberships (3k rows)", () => {
  const hot = uuid7();
  let hotTenant = "";

  beforeAll(async () => {
    await admin.query(
      `insert into tenancy.tenants (tenant_id, name) select uuidv7(), 'seed ' || g from generate_series(1, 600) g`,
    );
    await admin.query(
      `insert into tenancy.memberships (tenant_id, user_id)
       select t.tenant_id, uuidv7() from tenancy.tenants t, generate_series(1, 5)`,
    );
    const five = await admin.query<{ tenant_id: string }>(
      "select tenant_id from tenancy.tenants where name like 'seed %' order by tenant_id limit 5",
    );
    for (const r of five.rows) {
      await admin.query("insert into tenancy.memberships (tenant_id, user_id) values ($1, $2)", [
        r.tenant_id,
        hot,
      ]);
    }
    hotTenant = five.rows[0]?.tenant_id ?? "";
    await admin.query("analyze tenancy.memberships; analyze tenancy.tenants");
  });

  async function plan(
    run: <T>(fn: (tx: TxHandle) => Promise<T>) => Promise<T>,
    sql: string,
    params: unknown[],
  ): Promise<PlanNode[]> {
    return run(async (tx) => {
      // Force generic-free planning of the real statement; ANALYZE runs it for real under RLS.
      const text = await tx.query<{ "QUERY PLAN": string }>(
        `explain (analyze, buffers) ${sql}`,
        params,
      );
      console.log(
        `\n${sql.replace(/\s+/g, " ").slice(0, 110)}\n${text.rows.map((r) => r["QUERY PLAN"]).join("\n")}`,
      );
      const json = await tx.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
        `explain (format json) ${sql}`,
        params,
      );
      const root = json.rows[0]?.["QUERY PLAN"][0]?.Plan;
      if (root === undefined) throw new Error("no plan");
      return flatten(root);
    });
  }
  const noSeq = (nodes: PlanNode[]) =>
    nodes.filter((n) => n["Node Type"] === "Seq Scan").map((n) => n["Relation Name"]);

  it("membership by (tenant_id, user_id) uses an index", async () => {
    const nodes = await plan(
      (fn) => withTenantTx(app, tctx(hotTenant, hot), fn),
      "select id, status, branch_ids from tenancy.memberships where tenant_id = $1 and user_id = $2",
      [hotTenant, hot],
    );
    expect(noSeq(nodes)).toEqual([]);
    expect(nodes.some((n) => (n["Index Name"] ?? "").startsWith("memberships_"))).toBe(true);
  });

  it("memberships by user_id uses memberships_user_tenant_idx", async () => {
    const nodes = await plan(
      (fn) => withUserTx(app, uctx(hot), fn),
      "select tenant_id, id from tenancy.memberships where user_id = $1",
      [hot],
    );
    expect(noSeq(nodes)).toEqual([]);
    expect(nodes.some((n) => n["Index Name"] === "memberships_user_tenant_idx")).toBe(true);
  });

  it("'my tenants' join (one query) uses indexes on both sides", async () => {
    const nodes = await plan(
      (fn) => withUserTx(app, uctx(hot), fn),
      `select t.tenant_id, t.name from tenancy.memberships m
       join tenancy.tenants t on t.tenant_id = m.tenant_id
       where m.user_id = $1 and m.status = 'active'`,
      [hot],
    );
    expect(noSeq(nodes)).toEqual([]);
    const idx = nodes.map((n) => n["Index Name"]);
    expect(idx).toContain("memberships_user_tenant_idx");
    expect(idx).toContain("tenants_pkey");
  });

  it("the user sees their 5 seeded tenants and only those", async () => {
    const r = await withUserTx(app, uctx(hot), (tx) =>
      tx.query("select tenant_id from tenancy.tenants"),
    );
    expect(r.rowCount).toBe(5);
  });
});

describe("rls lint: policy shape", () => {
  it("flags permissive true policies and user_id in write policies; accepts the own-rows pattern", async () => {
    const db = await migratedDb([]);
    const c = createPool(db.url("admin"));
    try {
      await c.query(
        `create schema lint authorization wb_migrator; grant usage on schema lint to wb_app`,
      );
      const tenant = "tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid";
      const user = "user_id = nullif(current_setting('app.user_id', true), '')::uuid";
      for (const t of ["ok", "open_select", "user_write", "user_read"]) {
        await c.query(
          `create table lint.${t} (id uuid primary key default uuidv7(), tenant_id uuid not null, user_id uuid);
           alter table lint.${t} enable row level security; alter table lint.${t} force row level security;
           create policy tenant_isolation on lint.${t} using (${tenant}) with check (${tenant})`,
        );
      }
      await c.query(`
        create policy p on lint.open_select for select to wb_app using (true);
        create policy p on lint.user_write for insert to wb_app with check (${user});
        create policy p on lint.user_read for select to wb_app using (${user})`);
      expect(await findTablesWithoutRls(c, ["lint"])).toEqual([
        "lint.open_select",
        "lint.user_write",
      ]);
    } finally {
      await c.end();
      await db.drop();
    }
  });
});

describe("global schema check: chainer + functions", () => {
  it("flags wb_chainer table privileges and executable functions", async () => {
    const db = await migratedDb([fixture("leakyglobal")]);
    const c = createPool(db.url("admin"));
    try {
      await c.query("grant select on leakyglobal.accounts to wb_chainer");
      await c.query("create function leakyglobal.helper() returns int language sql as 'select 1'");
      const leaks = await findGlobalSchemaLeaks(c, ["leakyglobal"]);
      expect(leaks).toContain("leakyglobal.accounts -> wb_chainer");
      expect(leaks).toContain("leakyglobal.helper() -> wb_app");
      expect(leaks).toContain("leakyglobal.helper() -> wb_chainer");
    } finally {
      await c.end();
      await db.drop();
    }
  });
});
