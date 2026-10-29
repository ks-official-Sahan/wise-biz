import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, expect, it } from "vitest";

import { searchVariants } from "../src/query.ts";

import type pg from "pg";

// Opt-in (pnpm -F @wise-biz/module-search test:perf): 100k variants in ONE tenant (the worst case), plus 20k noise
// rows in other tenants. Acceptance: p95 < 150 ms (docs/prompts/P1/02-catalog-search.md).
const VARIANTS = 100_000;
const P95_BUDGET_MS = 150;
const T = uuidv7();

let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: join(import.meta.dirname, "..", "..", "infra", "migrations") },
    { module: "search", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
  admin = createPool(db.url("admin"));
  drop = async () => {
    await pool.end();
    await admin.end();
    await db.drop();
  };
  const seed = async (tenant: string | null, n: number) =>
    admin.query(
      `with brands as (select array['Coca-Cola','Pepsi','Sprite','Fanta','Nestle','Anchor','Maliban','Munchee','Elephant House',
         'Kotmale','Highland','Lipton','Dilmah','Prima','Keells','Cargills','Unilever','Sunlight','Lifebuoy','Signal',
         'Colgate','Dettol','Harpic','Vim','Lux','Dove','Pears','Baby Cheramy','Samaposha','Tiara','Ritzbury',
         'Kandos','Revello','Astra','Flora','Motha','Delmege','Raigam','Wijaya','MD','Edinborough','Bairaha','Crysbro',
         'Prima KottuMee','Maggi','Knorr','Red Bull','Monster','Lion','Three Coins'] as b),
       kinds as (select array['Cola','Orange','Milk Powder','Tea','Biscuits','Soap','Toothpaste','Noodles','Soya Meat',
         'Butter','Margarine','Cheese','Yoghurt','Ice Cream','Chocolate','Cream Crackers','Shampoo','Detergent',
         'Dishwash','Energy Drink','Beer','Water','Juice','Coffee','Sugar','Rice','Dhal','Flour','Salt','Chilli Powder',
         'Curry Powder','Coconut Oil','Sauce','Jam','Bread','Cake','Wafers','Chips','Mixture','Toffee'] as k),
       sizes as (select array['100g','200g','400g','1kg','250ml','330ml','500ml','1L','1.5L','2L','Pack of 6','Pack of 12',
         'Small','Medium','Large','Family Pack','Twin Pack','Refill','Jar','Sachet'] as s),
       rows as (
         select coalesce($1::uuid, uuidv7()) as tenant_id, uuidv7() as id, i,
           (select b[1 + (i * 7) % cardinality(b)] from brands) || ' ' ||
           (select k[1 + (i * 13) % cardinality(k)] from kinds) || ' ' ||
           (select s[1 + (i * 31) % cardinality(s)] from sizes) as title
         from generate_series(1, $2::int) i)
       insert into search.search_documents
         (tenant_id, kind, entity_id, product_id, title, sku, category_path, tags, tsv, source_time)
       select tenant_id, 'variant', id, id, title, 'SKU' || lpad(i::text, 7, '0'), array['Grocery'], array['tag' || (i % 50)],
         search.doc_tsv(title, 'SKU' || lpad(i::text, 7, '0'), array['tag' || (i % 50)], array['Grocery']), now()
       from rows`,
      [tenant, n],
    );
  await seed(T, VARIANTS - 1);
  await admin.query(
    `insert into search.search_documents (tenant_id, kind, entity_id, product_id, title, sku, tsv, source_time)
     values ($1, 'variant', $2, $2, 'Coca-Cola 1.5L', 'CC15', search.doc_tsv('Coca-Cola 1.5L', 'CC15', '{}', '{}'), now())`,
    [T, uuidv7()],
  );
  await seed(null, 20_000);
  await admin.query("analyze search.search_documents");
});
afterAll(async () => {
  await drop();
});

const QUERIES = [
  "cocacola 1.5",
  "coca cola",
  "coka cola",
  "pepsi 2l",
  "milk powder 400",
  "anchr milk",
  "dilmah tea",
  "elephant house cream soda",
  "SKU0012345",
  "sku00999",
  "maliban cream crackers",
  "munche",
  "keels",
  "noodles",
  "soap",
  "red bull",
  "colgate toothpaste large",
  "cocnut oil",
  "bairaha",
  "kotmale cheese",
];

it(`p95 < ${String(P95_BUDGET_MS)} ms on ${String(VARIANTS)} variants`, async () => {
  const run = (q: string) =>
    withTenantTx(pool, { tenantId: T, requestId: "perf" }, (tx) => searchVariants(tx, T, q, 20));
  for (const q of QUERIES) await run(q); // warm caches and plans
  // Plan of the slowest-looking query, for the progress log (EXPLAIN attached to the step).
  const plan = await withTenantTx(pool, { tenantId: T, requestId: "perf" }, async (tx) => {
    const seen: { text: string; values: unknown[] }[] = [];
    await searchVariants(
      {
        db: tx.db,
        query: (text, values) => (
          seen.push({ text, values: values ?? [] }),
          tx.query(text, values)
        ),
      },
      T,
      "coka cola",
      20,
    );
    const last = seen.at(-1);
    if (last === undefined) return [];
    const r = await tx.query<{ "QUERY PLAN": string }>(
      `explain (analyze, buffers) ${last.text}`,
      last.values,
    );
    return r.rows.map((x) => x["QUERY PLAN"]);
  });
  console.info(plan.join("\n"));
  const times: number[] = [];
  for (let round = 0; round < 10; round++) {
    for (const q of QUERIES) {
      const t0 = performance.now();
      await run(q);
      times.push(performance.now() - t0);
    }
  }
  times.sort((a, b) => a - b);
  const p = (x: number) => times[Math.min(times.length - 1, Math.floor(times.length * x))] ?? 0;
  const hits = await run("cocacola 1.5");
  console.info(
    `search ${String(times.length)} queries: p50 ${p(0.5).toFixed(1)} ms, p95 ${p(0.95).toFixed(1)} ms, ` +
      `max ${p(1).toFixed(1)} ms; top hit for "cocacola 1.5": ${hits[0]?.title ?? "none"}`,
  );
  expect(hits[0]?.title).toBe("Coca-Cola 1.5L");
  expect(p(0.95)).toBeLessThan(P95_BUDGET_MS);
});
