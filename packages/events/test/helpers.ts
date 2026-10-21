import { join } from "node:path";

import { createPool, migrate } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";

import type { EventMessage } from "../src/index.ts";
import type pg from "pg";

export const infraMigrations = join(import.meta.dirname, "../../../modules/infra/migrations");

export async function setupDb(): Promise<{
  worker: pg.Pool;
  admin: pg.Pool;
  drop: () => Promise<void>;
}> {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [{ module: "infra", dir: infraMigrations }]);
  const worker = createPool(db.url("worker"), { max: 8 });
  const admin = createPool(db.url("admin"), { max: 2 });
  return {
    worker,
    admin,
    drop: async () => {
      await worker.end();
      await admin.end();
      await db.drop();
    },
  };
}

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function message(tenantId: string, over: Partial<EventMessage> = {}): EventMessage {
  return {
    id: uuidv7(),
    tenantId,
    topic: "test",
    key: tenantId,
    type: "test.thing.happened",
    version: 1,
    payload: { n: 1 },
    headers: {},
    createdAt: new Date(),
    ...over,
  };
}
