import { join } from "node:path";

import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, expect, it } from "vitest";

import { listBalances, listMovements } from "../src/application/queries.ts";
import { selectBatchesFefo } from "../src/port.ts";

import type pg from "pg";

// Opt-in (pnpm -F @wise-biz/module-inventory test:perf). Acceptance (docs/prompts/P1/04-inventory.md): balance query
// p95 < 20 ms on a 10M-row ledger. 10M movements over 12 monthly partitions for one big tenant (5,000 variants x 20
// locations) plus noise tenants, balances derived from the ledger the way the port keeps them.
// CI runs the full 10M (default). A laptop Docker VM may die under that write load: PERF_MOVEMENTS=3000000 locally.
const MOVEMENTS = Number(process.env.PERF_MOVEMENTS ?? 10_000_000);
const VARIANTS = 5_000;
const LOCATIONS = 20;
const P95_BUDGET_MS = 20;
const T = uuidv7();

let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let variants: string[] = [];
let locations: string[] = [];

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: join(import.meta.dirname, "..", "..", "infra", "migrations") },
    { module: "inventory", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
  admin = createPool(db.url("admin"), { statementTimeoutMs: 1_800_000 });
  drop = async () => {
    await pool.end();
    await admin.end();
    await db.drop();
  };
  variants = Array.from({ length: VARIANTS }, () => uuidv7());
  locations = Array.from({ length: LOCATIONS }, () => uuidv7());
  // 1M rows per statement with a checkpoint between: one 10M-row statement exhausts a laptop Docker VM (the container
  // restarted mid-insert). Months back from now so every row lands in an existing partition (the migration keeps 12).
  const CHUNK = 1_000_000;
  for (let from = 1; from <= MOVEMENTS; from += CHUNK) {
    await admin.query(
      `insert into inventory.stock_movements (tenant_id, id, location_id, variant_id, qty, reason, source_type,
         source_id, source_line, occurred_at)
       select case when i % 10 = 0 then uuidv7() else $1::uuid end, uuidv7(), ($2::uuid[])[1 + i % $5],
         ($3::uuid[])[1 + (i / $5) % $6], case when i % 3 = 0 then 5 else -1 end,
         case when i % 3 = 0 then 'receive' else 'sale' end, 'seed', uuidv7(), 0,
         date_trunc('month', now()) - make_interval(months => i % 11) + make_interval(secs => i % 86400)
       from generate_series($4::int, $7::int) i`,
      [T, locations, variants, from, LOCATIONS, VARIANTS, Math.min(from + CHUNK - 1, MOVEMENTS)],
    );
    await admin.query("checkpoint");
  }
  await admin.query(
    `insert into inventory.stock_balances (tenant_id, location_id, variant_id, qty)
     select tenant_id, location_id, variant_id, sum(qty) from inventory.stock_movements
     where tenant_id = $1 group by 1, 2, 3`,
    [T],
  );
  await admin.query("analyze inventory.stock_movements");
  await admin.query("analyze inventory.stock_balances");
  // A fresh 10M-row load leaves dirty buffers and WAL behind; flush them so the timings measure queries, not I/O.
  await admin.query("vacuum (analyze) inventory.stock_balances");
  await admin.query("checkpoint");
}, 1_800_000);
afterAll(async () => {
  await drop();
});

const p = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)] ?? 0;

async function time(
  fn: (i: number) => Promise<unknown>,
  n = 200,
): Promise<{ p50: number; p95: number }> {
  for (let i = 0; i < 20; i++) await fn(i);
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    xs.push(performance.now() - t0);
  }
  return { p50: p(xs, 0.5), p95: p(xs, 0.95) };
}

const scoped = <R>(fn: (tx: Parameters<Parameters<typeof withTenantTx>[2]>[0]) => Promise<R>) =>
  withTenantTx(pool, { tenantId: T, requestId: "perf" }, fn);

it(`balance queries p95 < ${String(P95_BUDGET_MS)} ms on ${String(MOVEMENTS / 1e6)}M ledger rows`, async () => {
  const count = await admin.query<{ n: string }>(
    "select count(*)::text as n from inventory.stock_movements",
  );
  expect(Number(count.rows[0]?.n)).toBe(MOVEMENTS);

  // Under the app role (RLS on), so the plan is the one the port gets.
  const fefoPlan = await scoped((tx) =>
    tx.query<{ "QUERY PLAN": string }>(
      `explain (analyze, buffers) select s.batch_id from inventory.stock_balances s
       join inventory.batches b on b.tenant_id = s.tenant_id and b.id = s.batch_id
       where s.tenant_id = $1 and s.location_id = $2 and s.variant_id = $3 and s.qty - s.reserved > 0
       order by b.expires_on nulls last, b.received_at, b.id`,
      [T, locations[0], variants[0]],
    ),
  );
  console.info(["fefo plan:", ...fefoPlan.rows.map((r) => `  ${r["QUERY PLAN"]}`)].join("\n"));
  const byVariant = await time((i) =>
    scoped((tx) => listBalances(tx, T, { variantId: variants[(i * 37) % VARIANTS] })),
  );
  const byLocation = await time((i) =>
    scoped((tx) => listBalances(tx, T, { locationId: locations[i % LOCATIONS], limit: 200 })),
  );
  const history = await time((i) =>
    scoped((tx) =>
      listMovements(tx, T, { variantId: variants[(i * 53) % VARIANTS] ?? "", limit: 50 }),
    ),
  );
  const fefo = await time((i) =>
    scoped((tx) =>
      selectBatchesFefo(tx, T, {
        locationId: locations[i % LOCATIONS] ?? "",
        variantId: variants[(i * 11) % VARIANTS] ?? "",
        qty: "3",
        today: "2026-10-29",
      }),
    ),
  );
  const plan = await admin.query<{ "QUERY PLAN": string }>(
    `explain (analyze, buffers) select s.location_id, s.variant_id, sum(s.qty), sum(s.reserved)
     from inventory.stock_balances s where s.tenant_id = $1 and s.variant_id = $2
     group by s.location_id, s.variant_id order by s.location_id, s.variant_id limit 201`,
    [T, variants[0]],
  );
  const historyPlan = await admin.query<{ "QUERY PLAN": string }>(
    `explain (analyze, buffers) select id from inventory.stock_movements where tenant_id = $1 and variant_id = $2
     order by occurred_at desc, id desc limit 51`,
    [T, variants[0]],
  );
  console.info(
    [
      `inventory perf (${String(MOVEMENTS)} movements): balances by variant p50 ${byVariant.p50.toFixed(1)} / p95 ${byVariant.p95.toFixed(1)} ms;`,
      `by location (page 200) p50 ${byLocation.p50.toFixed(1)} / p95 ${byLocation.p95.toFixed(1)} ms;`,
      `history p50 ${history.p50.toFixed(1)} / p95 ${history.p95.toFixed(1)} ms; FEFO p95 ${fefo.p95.toFixed(1)} ms`,
      "balances by variant plan:",
      ...plan.rows.map((r) => `  ${r["QUERY PLAN"]}`),
      "history plan:",
      ...historyPlan.rows.slice(0, 12).map((r) => `  ${r["QUERY PLAN"]}`),
    ].join("\n"),
  );
  const plans = [...plan.rows, ...historyPlan.rows].map((r) => r["QUERY PLAN"]).join("\n");
  expect(plans).not.toMatch(/Seq Scan on stock_(balances|movements)/);
  expect(byVariant.p95).toBeLessThan(P95_BUDGET_MS);
  expect(byLocation.p95).toBeLessThan(P95_BUDGET_MS);
  expect(history.p95).toBeLessThan(P95_BUDGET_MS * 2);
});
