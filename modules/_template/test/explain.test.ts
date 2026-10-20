import { countQueries, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listItems } from "../src/application/items.ts";

import { ctx, repo, setup } from "./helpers.ts";

import type pg from "pg";

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

describe("query plans (1000 items per tenant)", () => {
  it("list and children lookups use indexes, never a sequential scan", async () => {
    const { statements } = await countQueries(() =>
      withTenantTx(pool, ctx(T), (tx) =>
        listItems({ repo }, tx, T, { limit: 50, include: ["children"] }),
      ),
    );
    expect(statements).toHaveLength(2);
    const plans: string[] = [];
    for (const sql of statements) {
      const res = await migrator.query<{ "QUERY PLAN": string }>(`explain (generic_plan) ${sql}`);
      plans.push(res.rows.map((r) => r["QUERY PLAN"]).join("\n"));
    }
    // Printed for the review record (EXPLAIN is a review gate: data-model.md Index rules 6).
    console.info(plans.join("\n---\n"));
    expect(plans[0]).toMatch(/Index (Only )?Scan using items_tenant_id_id_key/);
    expect(plans[1]).toMatch(
      /Index (Only )?Scan using item_children_tenant_item_idx|Bitmap Index Scan on item_children_tenant_item_idx/,
    );
    for (const p of plans) expect(p).not.toMatch(/Seq Scan/);
  });
});
