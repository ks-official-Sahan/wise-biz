import { withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedDemoTenant } from "../src/seed-demo.ts";

import { inTenant, memberAuth, setup } from "./helpers.ts";

import type pg from "pg";

let pool: pg.Pool;
let migrator: pg.Pool;
let drop: () => Promise<void>;
beforeAll(async () => {
  ({ pool, migrator, drop } = await setup());
});
afterAll(async () => {
  await drop();
});

describe("seedDemoTenant", () => {
  it("creates the demo business once (owner, two branches, one member per role), then reports exists", async () => {
    const tenantId = uuidv7();
    const owner = uuidv7();
    const cashier = uuidv7();
    const input = {
      tenantId,
      ownerUserId: owner,
      members: [
        { userId: cashier, roles: ["cashier"], scope: "store" as const },
        { userId: uuidv7(), roles: ["manager"], scope: "all" as const },
      ],
      now: new Date(0),
      ids: { uuidv7 },
      requestId: "seed-test",
    };
    expect(await seedDemoTenant(pool, input)).toBe("created");
    expect(await seedDemoTenant(pool, input)).toBe("exists");

    const branches = await inTenant(migrator, tenantId, async (q) =>
      q("select id, kind from tenancy.branches"),
    );
    expect(branches).toHaveLength(2);
    const store =
      (branches as { id: string; kind: string }[]).find((b) => b.kind === "store")?.id ?? "";

    const scoped = await memberAuth(pool, cashier, tenantId);
    expect(scoped).toMatchObject({ roles: ["cashier"], branchScope: [store] });
    const members = await inTenant(migrator, tenantId, async (q) =>
      q("select count(*)::int as n from tenancy.memberships"),
    );
    expect((members as { n: number }[])[0]?.n).toBe(3);
    const audit = await inTenant(migrator, tenantId, async (q) =>
      q("select count(*)::int as n from audit.audit_log where action = 'tenancy.demo.seeded'"),
    );
    expect((audit as { n: number }[])[0]?.n).toBe(1);
  });
});

/** Each EXPLAIN runs with sequential scans disabled, so the planner must use an index when one serves the query. */
async function plan(tenantId: string, sql: string, params: unknown[]) {
  return withTenantTx(pool, { tenantId, requestId: "explain" }, async (tx) => {
    await tx.query("set local enable_seqscan = off");
    const res = await tx.query<{ "QUERY PLAN": { Plan: Record<string, unknown> }[] }>(
      `explain (format json) ${sql}`,
      params,
    );
    return JSON.stringify(res.rows[0]?.["QUERY PLAN"] ?? []);
  });
}

describe("query plans of the admin lists", () => {
  it("members list, roles list and pending invites each use an index on the tenant", async () => {
    const tenantId = uuidv7();
    await seedDemoTenant(pool, {
      tenantId,
      ownerUserId: uuidv7(),
      members: [],
      now: new Date(0),
      ids: { uuidv7 },
      requestId: "explain-seed",
    });
    const members = await plan(
      tenantId,
      `select m.id from tenancy.memberships m
       left join tenancy.membership_roles mr on mr.tenant_id = m.tenant_id and mr.membership_id = m.id
       left join tenancy.roles r on r.tenant_id = mr.tenant_id and r.id = mr.role_id
       where m.tenant_id = $1 and ($2::uuid is null or m.id < $2::uuid)
       group by m.tenant_id, m.id order by m.id desc limit 51`,
      [tenantId, null],
    );
    expect(members).toMatch(/Index/);

    const roles = await plan(
      tenantId,
      `select r.id from tenancy.roles r
       left join tenancy.role_permissions rp on rp.tenant_id = r.tenant_id and rp.role_id = r.id
       where r.tenant_id = $1 group by r.tenant_id, r.id order by r.name`,
      [tenantId],
    );
    expect(roles).toMatch(/Index/);

    const invites = await plan(
      tenantId,
      `select id from tenancy.invites
       where tenant_id = $1 and accepted_at is null and revoked_at is null
       order by created_at desc, id desc limit 51`,
      [tenantId],
    );
    expect(invites).toMatch(/Index (Only )?Scan/);
    expect(invites).not.toMatch(/Seq Scan/);
  });
});
