import { join } from "node:path";

import { appendOutbox, createPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";

import type pg from "pg";

const infraMigrations = join(import.meta.dirname, "../../../modules/infra/migrations");

export interface Db {
  app: pg.Pool;
  worker: pg.Pool;
  admin: pg.Pool;
  workerUrl: string;
  drop: () => Promise<void>;
}

export async function setupDb(): Promise<Db> {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [{ module: "infra", dir: infraMigrations }]);
  const app = createPool(db.url("app"), { max: 4 });
  const worker = createPool(db.url("worker"), { max: 16 });
  const admin = createPool(db.url("admin"), { max: 2 });
  return {
    app,
    worker,
    admin,
    workerUrl: db.url("worker"),
    drop: async () => {
      await Promise.all([app.end(), worker.end(), admin.end()]);
      await db.drop();
    },
  };
}

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Append `n` events for a tenant through the real outbox helper, as wb_app. Returns their ids. */
export async function seedOutbox(
  app: pg.Pool,
  tenantId: string,
  n: number,
  type = "test.thing.happened",
): Promise<string[]> {
  const ids = Array.from({ length: n }, () => uuidv7());
  await withTenantTx(app, { tenantId, requestId: "test" }, (tx) =>
    appendOutbox(
      tx,
      ids.map((id, i) => ({
        id,
        topic: "test",
        key: tenantId,
        type,
        version: 1,
        payload: { i },
      })),
    ),
  );
  return ids;
}

export async function unpublished(admin: pg.Pool, tenantId: string): Promise<number> {
  const r = await admin.query<{ n: string }>(
    "select count(*) n from infra.outbox where tenant_id = $1 and published_at is null",
    [tenantId],
  );
  return Number(r.rows[0]?.n);
}

export async function processedCount(admin: pg.Pool, consumer: string): Promise<number> {
  const r = await admin.query<{ n: string }>(
    "select count(*) n from infra.processed_events where consumer = $1",
    [consumer],
  );
  return Number(r.rows[0]?.n);
}

export async function until(cond: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
