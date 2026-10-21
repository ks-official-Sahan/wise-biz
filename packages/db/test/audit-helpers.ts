import { join } from "node:path";

import { testDatabase } from "@wise-biz/testing/containers";

import { createPool, migrate } from "../src/index.ts";

import { infraDir } from "./infra-helpers.ts";

import type { AuditEntry } from "../src/index.ts";
import type pg from "pg";

export const auditDir = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "modules",
  "audit",
  "migrations",
);

export async function auditSetup(): Promise<{
  app: pg.Pool;
  chainer: pg.Pool;
  worker: pg.Pool;
  admin: pg.Pool;
  drop: () => Promise<void>;
}> {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: infraDir },
    { module: "audit", dir: auditDir },
  ]);
  const app = createPool(db.url("app"));
  const chainer = createPool(db.url("chainer"));
  const worker = createPool(db.url("worker"));
  const admin = createPool(db.url("admin"));
  return {
    app,
    chainer,
    worker,
    admin,
    drop: async () => {
      await Promise.all([app.end(), chainer.end(), worker.end(), admin.end()]);
      await db.drop();
    },
  };
}

let n = 0;
export const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  actorType: "user",
  actorId: "u1",
  action: "sale.void",
  entity: "sale",
  entityId: `s${String(++n)}`,
  before: { total: 100 },
  after: { total: 0, nested: { a: [1, 2, { b: "é😀" }] } },
  reason: "customer request",
  ip: "10.0.0.7",
  requestId: `req-${String(n)}`,
  ...over,
});
