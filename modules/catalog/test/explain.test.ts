import { join } from "node:path";

import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listProducts, lookupBarcode } from "../src/application/queries.ts";

import type { ListProductsQuery } from "../src/schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type pg from "pg";

const TENANTS = 300;
const PER_TENANT = 50;
const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");

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
const flatten = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(flatten)];

let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let tenantId = "";
let categoryId = "";
let code = "";

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "catalog", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
  admin = createPool(db.url("admin"));
  drop = async () => {
    await pool.end();
    await admin.end();
    await db.drop();
  };
  // 300 tenants x 50 products, one variant and one barcode each, one category per tenant (admin bypasses RLS).
  await admin.query(`
    with t as (select uuidv7() as tenant_id, n from generate_series(1, ${String(TENANTS)}) n),
    c as (insert into catalog.categories (id, tenant_id, name, path)
          select id, tenant_id, 'Cat', array[id] from (select uuidv7() as id, tenant_id from t) x
          returning id, tenant_id),
    p as (insert into catalog.products (id, tenant_id, name, category_id, created_by, updated_by)
          select uuidv7(), c.tenant_id, 'Product ' || i, c.id, c.tenant_id, c.tenant_id
          from c, generate_series(1, ${String(PER_TENANT)}) i returning id, tenant_id),
    v as (insert into catalog.variants (id, tenant_id, product_id, sku, name, created_by, updated_by)
          select uuidv7(), tenant_id, id, 'S' || replace(id::text, '-', ''), 'V', tenant_id, tenant_id from p
          returning id, tenant_id)
    insert into catalog.barcodes (tenant_id, variant_id, code, format)
    select tenant_id, id, replace(id::text, '-', ''), 'code128' from v`);
  await admin.query(
    "analyze catalog.categories, catalog.products, catalog.variants, catalog.barcodes",
  );
  const pick = await admin.query<{ tenant_id: string; category_id: string; code: string }>(
    `select p.tenant_id, p.category_id, b.code from catalog.products p
     join catalog.variants v on v.tenant_id = p.tenant_id and v.product_id = p.id
     join catalog.barcodes b on b.tenant_id = v.tenant_id and b.variant_id = v.id limit 1`,
  );
  const row = pick.rows[0];
  if (row === undefined) throw new Error("seed failed");
  ({ tenant_id: tenantId, category_id: categoryId, code } = row);
});
afterAll(async () => {
  await drop();
});

const run = <T>(fn: (tx: TxHandle) => Promise<T>) =>
  withTenantTx(pool, { tenantId, requestId: "x" }, fn);
const recording = (tx: TxHandle, into: Captured[]): TxHandle => ({
  db: tx.db,
  query: (text, values) => {
    into.push({ text, values: values ?? [] });
    return tx.query(text, values);
  },
});

/** EXPLAIN as wb_app with seq scans priced out, so the plan shows which index is USABLE for each recorded query. */
async function plans(seen: readonly Captured[]): Promise<PlanNode[][]> {
  const out: PlanNode[][] = [];
  for (const q of seen) {
    out.push(
      await run(async (tx) => {
        await tx.query("set local enable_seqscan = off");
        const res = await tx.query<{ "QUERY PLAN": { Plan: PlanNode }[] }>(
          `explain (analyze, buffers, format json) ${q.text}`,
          q.values,
        );
        const root = res.rows[0]?.["QUERY PLAN"][0]?.Plan;
        if (!root) throw new Error("no plan");
        return flatten(root);
      }),
    );
  }
  return out;
}
const indexes = (nodes: PlanNode[]) =>
  nodes.map((n) => n["Index Name"]).filter((x): x is string => x !== undefined);
const seq = (nodes: PlanNode[]) => nodes.some((n) => n["Node Type"] === "Seq Scan");
/** Every index on these tables leads with tenant_id; which one wins is the planner's call by statistics. */
const onTable = (nodes: PlanNode[], table: string) => {
  const used = indexes(nodes);
  return used.length > 0 && used.every((i) => i.startsWith(`${table}_`));
};

async function listPlans(q: ListProductsQuery) {
  const seen: Captured[] = [];
  await run((tx) => listProducts(recording(tx, seen), tenantId, q));
  return plans(seen);
}

describe(`query plans (${String(TENANTS)} tenants x ${String(PER_TENANT)} products)`, () => {
  it("list with includes: products, variants, barcodes and media each on a tenant-leading index", async () => {
    const [products, variants, barcodes, media] = await listPlans({
      limit: 50,
      include: "variants,barcodes,media",
    });
    const all = [products, variants, barcodes, media].map((p) => p ?? []);
    console.info(`list: ${all.map((p) => indexes(p).join("+")).join(" | ")}`);
    expect(all.some(seq)).toBe(false);
    expect(onTable(all[1] ?? [], "variants")).toBe(true);
    expect(onTable(all[2] ?? [], "barcodes")).toBe(true);
    expect(onTable(all[3] ?? [], "product_media")).toBe(true);
  });

  it("category subtree and updatedSince filters use their indexes", async () => {
    const [byCategory] = await listPlans({ categoryId });
    const [bySince] = await listPlans({
      updatedSince: new Date(Date.now() + 60_000).toISOString(),
    });
    console.info(
      `category: ${indexes(byCategory ?? []).join("+")}; since: ${indexes(bySince ?? []).join("+")}`,
    );
    expect(seq(byCategory ?? [])).toBe(false);
    expect(indexes(byCategory ?? [])).toContain("products_tenant_category_idx");
    expect(seq(bySince ?? [])).toBe(false);
  });

  it("barcode lookup is one unique-index probe", async () => {
    const seen: Captured[] = [];
    const hit = await run((tx) => lookupBarcode(recording(tx, seen), tenantId, code));
    expect(hit?.code).toBe(code);
    const [plan] = await plans(seen);
    console.info(`lookup: ${indexes(plan ?? []).join("+")}`);
    expect(seq(plan ?? [])).toBe(false);
    expect(indexes(plan ?? [])).toContain("barcodes_code_key");
  });
});
