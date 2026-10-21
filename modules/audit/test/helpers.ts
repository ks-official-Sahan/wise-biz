import { join } from "node:path";

import { appendAudit, createPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";

import type pg from "pg";

const root = join(import.meta.dirname, "../..");

export interface Db {
  app: pg.Pool;
  chainer: pg.Pool;
  admin: pg.Pool;
  drop: () => Promise<void>;
}

export async function setupDb(): Promise<Db> {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: join(root, "infra/migrations") },
    { module: "audit", dir: join(root, "audit/migrations") },
  ]);
  const app = createPool(db.url("app"), { max: 4 });
  const chainer = createPool(db.url("chainer"), { max: 4 });
  const admin = createPool(db.url("admin"), { max: 2 });
  return {
    app,
    chainer,
    admin,
    drop: async () => {
      await Promise.all([app.end(), chainer.end(), admin.end()]);
      await db.drop();
    },
  };
}

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Insert `n` audit rows for a tenant through the real helper, as wb_app. */
export async function seedAudit(app: pg.Pool, tenantId: string, n: number): Promise<void> {
  await withTenantTx(app, { tenantId, requestId: "test" }, (tx) =>
    appendAudit(
      tx,
      Array.from({ length: n }, (_, i) => ({
        actorType: "system" as const,
        actorId: "test",
        action: "thing.update",
        entity: "thing",
        entityId: uuidv7(),
        before: { i },
        after: { i: i + 1 },
        requestId: "test",
      })),
    ),
  );
}

export async function unchained(admin: pg.Pool, tenantId: string): Promise<number> {
  const r = await admin.query<{ n: string }>(
    "select count(*) n from audit.audit_log where tenant_id = $1 and hash is null",
    [tenantId],
  );
  return Number(r.rows[0]?.n);
}

/** Run SQL as superuser with triggers bypassed (simulates tampering by someone with DB access). */
export async function asSuperuserNoTriggers(
  admin: pg.Pool,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult> {
  const c = await admin.connect();
  try {
    await c.query("set session_replication_role = replica");
    return await c.query(sql, params);
  } finally {
    await c.query("reset session_replication_role");
    c.release();
  }
}

export async function until(cond: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
