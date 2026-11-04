import { withTenantTx, withUserTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { drizzleTenancyRepository as repo } from "../src/adapters/db/tenancy-repository.ts";
import { DEFAULT_ROLE_GRANTS, newBusiness } from "../src/domain/business.ts";

import { setup } from "./helpers.ts";

import type { TxHandle } from "@wise-biz/db";
import type pg from "pg";

const TENANTS = 300;
/** Any of these serves a (tenant_id, user_id) lookup; the planner picks by statistics. */
const MEMBERSHIP_INDEXES = new Set([
  "memberships_tenant_user_key",
  "memberships_user_tenant_idx",
  "memberships_pkey",
]);
const ME = uuidv7();
const MINE = [uuidv7(), uuidv7(), uuidv7()];
const OTHER_TENANT = uuidv7();

let pool: pg.Pool;
let migrator: pg.Pool;
let drop: () => Promise<void>;

interface Captured {
  text: string;
  values: unknown[];
}
interface PlanNode {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}
function only(seen: Captured[]): Captured {
  const [q] = seen;
  if (q === undefined || seen.length !== 1) throw new Error("expected exactly one recorded query");
  return q;
}
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

/** A tx whose raw queries are recorded, so EXPLAIN runs the exact SQL + params the repository sent. */
function recording(tx: TxHandle, into: Captured[]): TxHandle {
  return {
    db: tx.db,
    query: (text, values) => {
      into.push({ text, values: values ?? [] });
      return tx.query(text, values);
    },
  };
}

beforeAll(async () => {
  ({ pool, migrator, drop } = await setup());
  // 300 tenants (3 of them contain ME) in ONE transaction: the tenant setting is switched per tenant.
  const tenantIds = [...MINE, OTHER_TENANT, ...Array.from({ length: TENANTS - 4 }, () => uuidv7())];
  await withTenantTx(
    pool,
    { tenantId: tenantIds[0] ?? OTHER_TENANT, requestId: "seed" },
    async (tx) => {
      for (const tenantId of tenantIds) {
        await tx.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
        const rows = newBusiness(
          {
            tenantId,
            name: "T",
            branch: { name: "B", kind: "store", timezone: "UTC", currency: "USD", taxRegion: "US" },
          },
          {
            ownerUserId: MINE.includes(tenantId) ? ME : uuidv7(),
            nextId: uuidv7,
            now: new Date(0),
          },
        );
        await repo.insertBusiness(tx, rows);
      }
    },
  );
  await migrator.query(
    "analyze tenancy.tenants, tenancy.memberships, tenancy.membership_roles, tenancy.roles, tenancy.role_permissions",
  );
});
afterAll(async () => {
  await drop();
});

/** EXPLAIN as wb_app with the same settings; seq scans are priced out so the plan shows which index is USABLE. */
async function explain(
  run: <T>(fn: (tx: TxHandle) => Promise<T>) => Promise<T>,
  q: Captured,
): Promise<PlanNode[]> {
  return run(async (tx) => {
    await tx.query("set local enable_seqscan = off");
    const res = await tx.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
      `explain (analyze, buffers, format json) ${q.text}`,
      q.values,
    );
    const root = res.rows[0]?.["QUERY PLAN"][0]?.Plan;
    if (!root) throw new Error("no plan");
    return flatten(root);
  });
}

const used = (nodes: PlanNode[]): string[] =>
  nodes.map((n) => n["Index Name"]).filter((x): x is string => x !== undefined);

describe(`query plans (${String(TENANTS)} tenants)`, () => {
  it("listMyTenants: memberships_user_tenant_idx, no sequential scan on the big tables", async () => {
    const seen: Captured[] = [];
    const run = <T>(fn: (tx: TxHandle) => Promise<T>) =>
      withUserTx(pool, { userId: ME, requestId: "x" }, fn);
    const rows = await run((tx) => repo.listMyTenants(recording(tx, seen), ME));
    expect(rows).toHaveLength(3);
    expect(seen).toHaveLength(1);
    const nodes = await explain(run, only(seen));
    console.info(`listMyTenants: ${used(nodes).join(", ")}`);
    expect(used(nodes)).toContain("memberships_user_tenant_idx");
    expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
  });

  it("hasActiveMembership: a (tenant_id, user_id) index", async () => {
    const seen: Captured[] = [];
    const run = <T>(fn: (tx: TxHandle) => Promise<T>) =>
      withUserTx(pool, { userId: ME, requestId: "x" }, fn);
    expect(
      await run((tx) => repo.hasActiveMembership(recording(tx, seen), ME, MINE[0] ?? "")),
    ).toBe(true);
    const nodes = await explain(run, only(seen));
    console.info(`hasActiveMembership: ${used(nodes).join(", ")}`);
    expect(used(nodes).some((i) => MEMBERSHIP_INDEXES.has(i))).toBe(true);
    expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
  });

  it("loadMembership: membership index, membership_roles and roles by (tenant_id, ...) keys", async () => {
    const seen: Captured[] = [];
    const tenantId = MINE[1] ?? "";
    const run = <T>(fn: (tx: TxHandle) => Promise<T>) =>
      withTenantTx(pool, { tenantId, userId: ME, requestId: "x" }, fn);
    const m = await run((tx) => repo.loadMembership(recording(tx, seen), ME, tenantId));
    expect(m?.roles).toEqual(["owner"]);
    expect(seen).toHaveLength(1);
    const nodes = await explain(run, only(seen));
    console.info(`loadMembership: ${used(nodes).join(", ")}`);
    const idx = used(nodes);
    expect(idx.some((i) => MEMBERSHIP_INDEXES.has(i))).toBe(true);
    expect(idx).toContain("membership_roles_pkey");
    expect(idx).toContain("roles_pkey");
    expect(idx).toContain("tenants_pkey");
    expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
  });

  it("loadPolicyRows: role_permissions_tenant_role_idx / roles_pkey", async () => {
    const seen: Captured[] = [];
    const tenantId = MINE[2] ?? "";
    const run = <T>(fn: (tx: TxHandle) => Promise<T>) =>
      withTenantTx(pool, { tenantId, requestId: "x" }, fn);
    const rows = await run((tx) => repo.loadPolicyRows(recording(tx, seen), tenantId));
    expect(rows).toHaveLength(Object.values(DEFAULT_ROLE_GRANTS).flat().length);
    const nodes = await explain(run, only(seen));
    console.info(`loadPolicyRows: ${used(nodes).join(", ")}`);
    // (tenant_id, role_id, id) index or the (tenant_id, role_id, permission) unique key: both lead with tenant_id.
    expect(
      used(nodes).some(
        (i) =>
          i === "role_permissions_tenant_role_idx" || i === "role_permissions_role_permission_key",
      ),
    ).toBe(true);
    expect(used(nodes)).toContain("roles_pkey");
    expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
  });
});
