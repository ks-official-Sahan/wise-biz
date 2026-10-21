import { join } from "node:path";

import { createPool, instrumentPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";

import { drizzleItemRepository } from "../src/adapters/db/item-repository.ts";
import { createItem } from "../src/application/items.ts";

import type { Clock, Ids } from "../src/ports/item-repository.ts";
import type pg from "pg";

export const migrationsDir = join(import.meta.dirname, "..", "migrations");
export const infraDir = join(import.meta.dirname, "..", "..", "infra", "migrations");
export const auditDir = join(import.meta.dirname, "..", "..", "audit", "migrations");
export const repo = drizzleItemRepository;
export const clock: Clock = { now: () => Date.UTC(2026, 0, 1) };
export const ids: Ids = { uuidv7 };
export const ctx = (tenantId: string) => ({ tenantId, requestId: "test" });

export async function setup(): Promise<{
  pool: pg.Pool;
  migrator: pg.Pool;
  drop: () => Promise<void>;
}> {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: infraDir },
    { module: "audit", dir: auditDir },
    { module: "_template", dir: migrationsDir },
  ]);
  const pool = createPool(db.url("app"));
  instrumentPool(pool);
  const migrator = createPool(db.url("migrator"));
  return {
    pool,
    migrator,
    drop: async () => {
      await pool.end();
      await migrator.end();
      await db.drop();
    },
  };
}

/** Insert `n` items (with `kids` children each) for a tenant, in one tx. */
export async function seed(pool: pg.Pool, tenantId: string, n: number, kids = 0): Promise<void> {
  await withTenantTx(pool, ctx(tenantId), async (tx) => {
    for (let i = 0; i < n; i++) {
      await createItem({ repo, clock, ids }, tx, tenantId, {
        name: `item ${String(i)}`,
        children: Array.from({ length: kids }, (_, k) => `child ${String(k)}`),
      });
    }
  });
}
