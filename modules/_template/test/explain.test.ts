import { withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listItems } from "../src/application/items.ts";

import { ctx, repo, setup } from "./helpers.ts";

import type pg from "pg";

interface Captured {
  text: string;
  values: unknown[];
}

const T = uuidv7();
const U = uuidv7();
let pool: pg.Pool;
let migrator: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ pool, migrator, drop } = await setup());
  // 1000 items for T (+2 children each) and 1000 for another tenant, so the tenant_id lead matters.
  for (const t of [T, U]) {
    await withTenantTx(pool, ctx(t), async (tx) => {
      await tx.query(
        "insert into template.items (tenant_id, name) select $1, 'i' || g from generate_series(1, 1000) g",
        [t],
      );
      await tx.query(
        "insert into template.item_children (tenant_id, item_id, label) select $1, i.id, 'c' || k from template.items i, generate_series(1, 2) k",
        [t],
      );
    });
  }
  await migrator.query("analyze template.items; analyze template.item_children");
});
afterAll(async () => {
  await drop();
});

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];
const INDEX_SCANS = ["Index Scan", "Index Only Scan"];

/** Run `fn` and return the exact SQL + bind params the pool sent for it (BEGIN/set_config housekeeping excluded). */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; queries: Captured[] }> {
  const queries: Captured[] = [];
  const connect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
    const client = await connect();
    const orig = client.query.bind(client) as (...a: unknown[]) => unknown;
    (client as unknown as { query: (...a: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const a0 = args[0];
      const text = typeof a0 === "string" ? a0 : (a0 as { text?: string }).text;
      const values = ((a0 as { values?: unknown[] }).values ?? args[1]) as unknown[] | undefined;
      if (text && /^\s*select\s+"/i.test(text)) queries.push({ text, values: values ?? [] });
      return orig(...args);
    };
    return client;
  };
  try {
    return { result: await fn(), queries };
  } finally {
    (pool as unknown as { connect: typeof connect }).connect = connect;
  }
}

/** EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) as wb_app inside a tenant tx: RLS is active, params are real. */
async function explain(tenantId: string, q: Captured): Promise<PlanNode[]> {
  return withTenantTx(pool, ctx(tenantId), async (tx) => {
    // SSD-class cost (production default for our fleet); the default 4.0 over-prices index scans on a 4k-row table.
    await tx.query("set local random_page_cost = 1.1");
    const res = await tx.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
      `explain (analyze, buffers, format json) ${q.text}`,
      q.values,
    );
    const root = res.rows[0]?.["QUERY PLAN"][0]?.Plan;
    if (!root) throw new Error("no plan");
    return flatten(root);
  });
}

describe("query plans (1000 items x 2 children per tenant, 2 tenants)", () => {
  it("list and children queries use indexes, never a sequential scan", async () => {
    const { result: first, queries } = await capture(() =>
      withTenantTx(pool, ctx(T), (tx) =>
        listItems({ repo }, tx, T, { limit: 50, include: ["children"] }),
      ),
    );
    expect(queries).toHaveLength(2);
    // Second page: keyset `id > $after` with a real cursor.
    const { queries: page2 } = await capture(() =>
      withTenantTx(pool, ctx(T), (tx) =>
        listItems({ repo }, tx, T, { limit: 50, after: first.nextCursor ?? "" }),
      ),
    );
    const [list, children] = queries as [Captured, Captured];
    const [page2Query] = page2 as [Captured];

    const listNodes = await explain(T, list);
    const list2Nodes = await explain(T, page2Query);
    const childNodes = await explain(T, children);

    // Printed for the review record (EXPLAIN is a review gate: data-model.md Index rules).
    const summary = (name: string, nodes: PlanNode[]): string =>
      `${name}: ${nodes.map((n) => `${n["Node Type"]}${n["Index Name"] ? ` using ${n["Index Name"]}` : ""}${n["Relation Name"] ? ` on ${n["Relation Name"]}` : ""}`).join(" > ")}`;
    console.info(
      [
        summary("list", listNodes),
        summary("list page 2", list2Nodes),
        summary("children", childNodes),
      ].join("\n"),
    );

    for (const nodes of [listNodes, list2Nodes, childNodes]) {
      expect(nodes.map((n) => n["Node Type"])).not.toContain("Seq Scan");
    }
    for (const nodes of [listNodes, list2Nodes]) {
      const scans = nodes.filter((n) => n["Relation Name"] === "items");
      expect(scans).toHaveLength(1);
      expect(INDEX_SCANS).toContain(scans[0]?.["Node Type"]);
      expect(scans[0]?.["Index Name"]).toBe("items_pkey");
    }
    const kids = childNodes.filter((n) => n["Relation Name"] === "item_children");
    expect(kids).toHaveLength(1);
    expect(INDEX_SCANS).toContain(kids[0]?.["Node Type"]);
    expect(kids[0]?.["Index Name"]).toBe("item_children_tenant_item_idx");
  });
});

describe("repository limits", () => {
  it("childrenFor rejects more than 200 item ids", async () => {
    const tooMany = Array.from({ length: 201 }, () => uuidv7());
    await expect(
      withTenantTx(pool, ctx(T), (tx) => repo.childrenFor(tx, T, tooMany)),
    ).rejects.toThrow(RangeError);
  });
});
