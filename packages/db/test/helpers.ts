import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { testDatabase } from "@wise-biz/testing/containers";

import { migrate } from "../src/index.ts";

import type { ModuleEntry } from "../src/index.ts";

export const fixturesDir = join(import.meta.dirname, "fixtures", "modules");
export const fixture = (module: string, dir = module): ModuleEntry => ({
  module,
  dir: join(fixturesDir, dir, "migrations"),
});

/** Random valid UUIDv7-shaped id (version 7, variant 8). */
export function uuid7(): string {
  const h = randomBytes(16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function migratedDb(entries: ModuleEntry[]) {
  const db = await testDatabase();
  await migrate(db.url("migrator"), entries);
  return db;
}
