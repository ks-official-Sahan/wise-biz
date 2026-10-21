import { join } from "node:path";

import { testDatabase } from "@wise-biz/testing/containers";

import { createPool, migrate } from "../src/index.ts";

import { uuid7 } from "./helpers.ts";

import type pg from "pg";

export const infraDir = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "modules",
  "infra",
  "migrations",
);
export const ctx = (tenantId: string) => ({ tenantId, requestId: "test" });

export async function infraSetup(): Promise<{
  app: pg.Pool;
  worker: pg.Pool;
  migrator: pg.Pool;
  drop: () => Promise<void>;
}> {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [{ module: "infra", dir: infraDir }]);
  const app = createPool(db.url("app"));
  const worker = createPool(db.url("worker"));
  const migrator = createPool(db.url("migrator"));
  return {
    app,
    worker,
    migrator,
    drop: async () => {
      await Promise.all([app.end(), worker.end(), migrator.end()]);
      await db.drop();
    },
  };
}

export const event = (over: Record<string, unknown> = {}) => ({
  id: uuid7(),
  topic: "sales",
  key: "k",
  type: "sales.sale.completed",
  version: 1,
  payload: { a: 1 },
  ...over,
});
