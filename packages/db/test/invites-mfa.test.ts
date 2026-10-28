import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPool,
  findGlobalSchemaLeaks,
  findTablesWithoutRls,
  loadGlobalSchemas,
  loadRegistry,
  withTenantTx,
} from "../src/index.ts";

import { migratedDb, uuid7 } from "./helpers.ts";

import type { TxHandle } from "../src/index.ts";
import type pg from "pg";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const tctx = (tenantId: string) => ({ tenantId, requestId: "t" });

let app: pg.Pool;
let identity: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let globals: string[];
let allSchemas: string[];

beforeAll(async () => {
  const entries = await loadRegistry(repoRoot);
  globals = await loadGlobalSchemas(repoRoot);
  allSchemas = entries.map((e) => e.module.replace(/^_/, ""));
  // Applies every migration (infra, audit, identity 0001-0002, tenancy 0001-0002, _template) on a fresh database.
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
  await admin.query("insert into tenancy.tenants (tenant_id, name) values ($1, $2)", [id, name]);
  return id;
}

async function newUser(): Promise<string> {
  const id = uuid7();
  await identity.query("insert into identity.users (id, name, email) values ($1, 'U', $2)", [
    id,
    `u-${id}@x.test`,
  ]);
  return id;
}

const insertInvite = (tx: TxHandle, tenantId: string, email: string) =>
  tx.query(
    `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at)
     values ($1, $2, array[$3::uuid], $4, now() + interval '72 hours')`,
    [tenantId, email, uuid7(), uuid7()],
  );

describe("migrations and lint", () => {
  it("registry order matches the migrated schemas; identity is the only global schema", () => {
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

  it("every non-global table passes the RLS lint (tenancy.invites included)", async () => {
    const nonGlobal = allSchemas.filter((s) => !globals.includes(s));
    expect(await findTablesWithoutRls(admin, nonGlobal)).toEqual([]);
    expect(await findTablesWithoutRls(admin, ["tenancy"])).toEqual([]);
  });

  it("identity passes the global schema check (no wb_app / wb_worker / wb_chainer / PUBLIC privileges)", async () => {
    expect(await findGlobalSchemaLeaks(admin, ["identity"])).toEqual([]);
  });

  it("tenancy.invites has forced RLS with the exact tenant_isolation policy", async () => {
    const r = await admin.query<{ rls: boolean; force: boolean; policies: number }>(
      `select c.relrowsecurity rls, c.relforcerowsecurity force,
              (select count(*)::int from pg_policies p where p.schemaname = 'tenancy' and p.tablename = 'invites') policies
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'tenancy' and c.relname = 'invites'`,
    );
    expect(r.rows[0]).toEqual({ rls: true, force: true, policies: 1 });
  });

  it("new id columns default to UUIDv7", async () => {
    const t = await newTenant("v7");
    const r = await admin.query<{ id: string }>(
      `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at)
       values ($1, 'v7@x.test', array[gen_random_uuid()], gen_random_uuid(), now())
       returning id`,
      [t],
    );
    expect(r.rows[0]?.id[14]).toBe("7");
    const u = await identity.query<{ id: string }>(
      "insert into identity.users (name, email) values ('V', 'v7-user@x.test') returning id",
    );
    expect(u.rows[0]?.id[14]).toBe("7");
  });
});

describe("tenancy.invites: RLS and constraints", () => {
  it("tenant A cannot see or write B's invites; missing setting returns no rows", async () => {
    const a = await newTenant("A");
    const b = await newTenant("B");
    await withTenantTx(app, tctx(a), (tx) => insertInvite(tx, a, "a1@x.test"));
    await withTenantTx(app, tctx(b), (tx) => insertInvite(tx, b, "b1@x.test"));

    const seen = await withTenantTx(app, tctx(a), (tx) =>
      tx.query<{ tenant_id: string }>("select tenant_id from tenancy.invites"),
    );
    expect(seen.rows.map((r) => r.tenant_id)).toEqual([a]);

    await expect(
      withTenantTx(app, tctx(a), (tx) => insertInvite(tx, b, "smuggled@x.test")),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenantTx(app, tctx(a), (tx) =>
        tx.query("update tenancy.invites set revoked_at = now() where tenant_id = $1", [b]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });

    expect((await app.query("select 1 from tenancy.invites")).rowCount).toBe(0);
  });

  it("composite tenant FK: an invite cannot reference a tenant that does not exist", async () => {
    await expect(
      admin.query(
        `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at)
         values ($1, 'ghost@x.test', array[$2::uuid], $3, now())`,
        [uuid7(), uuid7(), uuid7()],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("check constraints: lowercase email, role count, non-empty branch scope, not accepted and revoked", async () => {
    const t = await newTenant();
    const run = (sql: string, params: unknown[]) =>
      withTenantTx(app, tctx(t), (tx) => tx.query(sql, params));
    const base = `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at, branch_ids
                  ) values ($1, $2, $3::uuid[], $4, now(), $5::uuid[])`;
    const role = [uuid7()];
    await expect(run(base, [t, "Upper@x.test", role, uuid7(), null])).rejects.toThrow(
      /check constraint/,
    );
    await expect(run(base, [t, "ok@x.test", [], uuid7(), null])).rejects.toThrow(
      /check constraint/,
    );
    await expect(run(base, [t, "ok@x.test", role, uuid7(), "{}"])).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      run(
        `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at, accepted_at, revoked_at)
         values ($1, 'both@x.test', $2::uuid[], $3, now(), now(), now())`,
        [t, role, uuid7()],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("partial unique: one pending invite per email; allowed again after revoke or accept", async () => {
    const t = await newTenant();
    const email = "dup@x.test";
    const first = await withTenantTx(app, tctx(t), (tx) =>
      tx.query<{ id: string }>(
        `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at)
         values ($1, $2, array[$3::uuid], $4, now() + interval '72 hours') returning id`,
        [t, email, uuid7(), uuid7()],
      ),
    );
    const pending = (tx: TxHandle) => insertInvite(tx, t, email);
    await expect(withTenantTx(app, tctx(t), pending)).rejects.toThrow(/duplicate key/);

    // revoke the first: a new pending invite for the same email is now allowed
    await withTenantTx(app, tctx(t), (tx) =>
      tx.query("update tenancy.invites set revoked_at = now() where tenant_id = $1 and id = $2", [
        t,
        first.rows[0]?.id,
      ]),
    );
    const second = await withTenantTx(app, tctx(t), (tx) =>
      tx.query<{ id: string }>(
        `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at)
         values ($1, $2, array[$3::uuid], $4, now()) returning id`,
        [t, email, uuid7(), uuid7()],
      ),
    );
    await expect(withTenantTx(app, tctx(t), pending)).rejects.toThrow(/duplicate key/);

    // accept the second: allowed again
    await withTenantTx(app, tctx(t), (tx) =>
      tx.query(
        "update tenancy.invites set accepted_at = now(), accepted_by = $3 where tenant_id = $1 and id = $2",
        [t, second.rows[0]?.id, uuid7()],
      ),
    );
    await expect(withTenantTx(app, tctx(t), pending)).resolves.toBeDefined();
    // another tenant may hold a pending invite for the same email
    const other = await newTenant();
    await expect(
      withTenantTx(app, tctx(other), (tx) => insertInvite(tx, other, email)),
    ).resolves.toBeDefined();
  });

  it("accepted and revoked are terminal, and accepted_at pairs with accepted_by", async () => {
    const t = await newTenant();
    const inv = async (email: string): Promise<string> => {
      const r = await withTenantTx(app, tctx(t), (tx) =>
        tx.query<{ id: string }>(
          `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at)
           values ($1, $2, array[$3::uuid], $4, now() + interval '72 hours') returning id`,
          [t, email, uuid7(), uuid7()],
        ),
      );
      return r.rows[0]?.id ?? "";
    };
    const run = (sql: string, id: string, ...extra: unknown[]) =>
      withTenantTx(app, tctx(t), (tx) => tx.query(sql, [t, id, ...extra]));

    const accepted = await inv("acc@x.test");
    await expect(
      run(
        "update tenancy.invites set accepted_at = now() where tenant_id = $1 and id = $2",
        accepted,
      ),
    ).rejects.toThrow(/invites_accepted_pair/);
    await run(
      "update tenancy.invites set accepted_at = now(), accepted_by = $3 where tenant_id = $1 and id = $2",
      accepted,
      uuid7(),
    );
    // Reopen, re-stamp and revoke-after-accept are all refused by the trigger.
    await expect(
      run(
        "update tenancy.invites set accepted_at = null, accepted_by = null where tenant_id = $1 and id = $2",
        accepted,
      ),
    ).rejects.toThrow(/already settled/);
    await expect(
      run(
        "update tenancy.invites set revoked_at = now() where tenant_id = $1 and id = $2",
        accepted,
      ),
    ).rejects.toThrow(/already settled/);

    const revoked = await inv("rev@x.test");
    await run(
      "update tenancy.invites set revoked_at = now() where tenant_id = $1 and id = $2",
      revoked,
    );
    await expect(
      run("update tenancy.invites set revoked_at = null where tenant_id = $1 and id = $2", revoked),
    ).rejects.toThrow(/already settled/);
  });
});

describe("tenancy.invites: least-privilege grants", () => {
  it("wb_app cannot UPDATE invites.email, role_ids, invited_by or expires_at", async () => {
    const t = await newTenant();
    await withTenantTx(app, tctx(t), (tx) => insertInvite(tx, t, "frozen@x.test"));
    for (const col of [
      "email = 'other@x.test'",
      "role_ids = array[gen_random_uuid()]",
      "invited_by = gen_random_uuid()",
      "expires_at = now()",
    ]) {
      await expect(
        withTenantTx(app, tctx(t), (tx) => tx.query(`update tenancy.invites set ${col}`)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("wb_app cannot DELETE or TRUNCATE invites", async () => {
    const t = await newTenant();
    await expect(
      withTenantTx(app, tctx(t), (tx) => tx.query("delete from tenancy.invites")),
    ).rejects.toThrow(/permission denied/);
    await expect(app.query("truncate tenancy.invites")).rejects.toThrow(/permission denied/);
  });

  it("wb_app may accept or revoke (the granted columns)", async () => {
    const t = await newTenant();
    const inv = await withTenantTx(app, tctx(t), (tx) =>
      tx.query<{ id: string }>(
        `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at)
         values ($1, 'grant@x.test', array[$2::uuid], $3, now() + interval '1 day') returning id`,
        [t, uuid7(), uuid7()],
      ),
    );
    const r = await withTenantTx(app, tctx(t), (tx) =>
      tx.query("update tenancy.invites set revoked_at = now() where tenant_id = $1 and id = $2", [
        t,
        inv.rows[0]?.id,
      ]),
    );
    expect(r.rowCount).toBe(1);
  });
});

describe("identity: two_factors and passkeys are wb_identity-only", () => {
  it("wb_app gets permission denied on identity.passkeys and identity.two_factors", async () => {
    await expect(app.query("select 1 from identity.passkeys")).rejects.toThrow(/permission denied/);
    await expect(app.query("select 1 from identity.two_factors")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      withTenantTx(app, tctx(uuid7()), (tx) => tx.query("select 1 from identity.passkeys")),
    ).rejects.toThrow(/permission denied/);
  });

  it("wb_identity can write them; defaults and constraints hold", async () => {
    const u = await newUser();
    const tf = await identity.query<{ id: string }>(
      "insert into identity.two_factors (user_id, secret, backup_codes) values ($1, 's', 'c') returning id",
      [u],
    );
    expect(tf.rows[0]?.id[14]).toBe("7");
    await expect(
      identity.query(
        "insert into identity.two_factors (user_id, secret, backup_codes) values ($1, 's', 'c')",
        [u],
      ),
    ).rejects.toThrow(/duplicate key/);

    const pk = await identity.query<{ id: string }>(
      `insert into identity.passkeys (public_key, user_id, credential_id, counter, device_type, backed_up)
       values ('pk', $1, 'cred-1', 0, 'singleDevice', false) returning id`,
      [u],
    );
    expect(pk.rows[0]?.id[14]).toBe("7");
    await expect(
      identity.query(
        `insert into identity.passkeys (public_key, user_id, credential_id, counter, device_type, backed_up)
         values ('pk', $1, 'cred-1', 0, 'singleDevice', false)`,
        [u],
      ),
    ).rejects.toThrow(/duplicate key/);
    const flag = await identity.query<{ two_factor_enabled: boolean }>(
      "select two_factor_enabled from identity.users where id = $1",
      [u],
    );
    expect(flag.rows[0]?.two_factor_enabled).toBe(false);
  });

  it("deleting a user cascades to two_factors and passkeys", async () => {
    const u = await newUser();
    await identity.query(
      "insert into identity.two_factors (user_id, secret, backup_codes) values ($1, 's', 'c')",
      [u],
    );
    await identity.query(
      `insert into identity.passkeys (public_key, user_id, credential_id, counter, device_type, backed_up)
       values ('pk', $1, $2, 0, 'multiDevice', true)`,
      [u, `cred-${u}`],
    );
    await identity.query("delete from identity.users where id = $1", [u]);
    const [tf, pk] = await Promise.all([
      identity.query("select 1 from identity.two_factors where user_id = $1", [u]),
      identity.query("select 1 from identity.passkeys where user_id = $1", [u]),
    ]);
    expect([tf.rowCount, pk.rowCount]).toEqual([0, 0]);
  });
});

interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

describe("EXPLAIN as wb_app: invites listing (2.4k seeded rows)", () => {
  let hot = "";

  beforeAll(async () => {
    await admin.query(
      "insert into tenancy.tenants (tenant_id, name) select uuidv7(), 'inv seed ' || g from generate_series(1, 24) g",
    );
    // 24 tenants x 100 invites = 2,400 rows; every 5th is accepted, every 7th revoked.
    await admin.query(
      `insert into tenancy.invites
         (tenant_id, email, role_ids, invited_by, expires_at, created_at, accepted_at, accepted_by, revoked_at)
       select t.tenant_id, 'seed' || g || '@x.test', array[uuidv7()], uuidv7(), now() + interval '72 hours',
              now() - (g || ' minutes')::interval,
              case when g % 5 = 0 then now() end,
              case when g % 5 = 0 then uuidv7() end,
              case when g % 7 = 0 and g % 5 <> 0 then now() end
       from tenancy.tenants t cross join generate_series(1, 100) g
       where t.name like 'inv seed %'`,
    );
    const r = await admin.query<{ tenant_id: string }>(
      "select tenant_id from tenancy.tenants where name like 'inv seed %' order by name limit 1",
    );
    hot = r.rows[0]?.tenant_id ?? "";
    // One large tenant (2,100 invites) so the listing is planned against a realistic hot tenant, not a 100-row one.
    await admin.query(
      `insert into tenancy.invites (tenant_id, email, role_ids, invited_by, expires_at, created_at)
       select $1::uuid, 'big' || g || '@x.test', array[uuidv7()], uuidv7(), now() + interval '72 hours',
              now() - (g || ' seconds')::interval
       from generate_series(1, 2000) g`,
      [hot],
    );
    await admin.query("analyze tenancy.invites");
  });

  it("the listing query uses tenancy.invites index and never a sequential scan", async () => {
    const sql = `select id, email, role_ids, branch_ids, expires_at, created_at from tenancy.invites
                 where tenant_id = $1 and accepted_at is null and revoked_at is null
                 order by created_at desc, id desc limit 50`;
    const nodes = await withTenantTx(app, tctx(hot), async (tx: TxHandle) => {
      const text = await tx.query<{ "QUERY PLAN": string }>(`explain (analyze, buffers) ${sql}`, [
        hot,
      ]);
      console.log(
        `\n${sql.replace(/\s+/g, " ")}\n${text.rows.map((r) => r["QUERY PLAN"]).join("\n")}`,
      );
      const json = await tx.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
        `explain (format json) ${sql}`,
        [hot],
      );
      const root = json.rows[0]?.["QUERY PLAN"][0]?.Plan;
      if (root === undefined) throw new Error("no plan");
      return flatten(root);
    });
    expect(nodes.filter((n) => n["Node Type"] === "Seq Scan")).toEqual([]);
    expect(nodes.some((n) => (n["Index Name"] ?? "").startsWith("invites_"))).toBe(true);
  });

  it("the listing returns only this tenant's pending invites, newest first", async () => {
    const rows = await withTenantTx(app, tctx(hot), (tx) =>
      tx.query<{ accepted_at: unknown; revoked_at: unknown; created_at: Date }>(
        `select accepted_at, revoked_at, created_at from tenancy.invites
         where tenant_id = $1 and accepted_at is null and revoked_at is null
         order by created_at desc, id desc limit 50`,
        [hot],
      ),
    );
    expect(rows.rowCount).toBe(50);
    expect(rows.rows.every((r) => r.accepted_at === null && r.revoked_at === null)).toBe(true);
    const times = rows.rows.map((r) => r.created_at.getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });
});
