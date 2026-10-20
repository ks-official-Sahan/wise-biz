import { randomBytes } from "node:crypto";

import { inject } from "vitest";

import { attachPostgres, startPostgres } from "./postgres.ts";

import type { PgHarness, PgRole } from "./postgres.ts";
import type { ProvidedContext } from "vitest";

export interface WbPgInfo {
  host: string;
  port: number;
}

declare module "vitest" {
  interface ProvidedContext {
    wbPg: WbPgInfo;
  }
}

export interface PostgresGlobalSetupOptions {
  /** Runs against the started server before wb_base is used (e.g. create a migrated template). */
  prepare?: (pg: PgHarness) => Promise<void>;
}

interface ProjectLike {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
}

/** Vitest globalSetup factory: `export default postgresGlobalSetup()`. */
export function postgresGlobalSetup(
  options: PostgresGlobalSetupOptions = {},
): (project: ProjectLike) => Promise<() => Promise<void>> {
  return async (project) => {
    const pg = await startPostgres();
    try {
      await options.prepare?.(pg);
    } catch (error) {
      await pg.stop();
      throw error;
    }
    project.provide("wbPg", { host: pg.host, port: pg.port });
    return () => pg.stop();
  };
}

export interface TestDatabase {
  name: string;
  url(role?: PgRole): string;
  drop(): Promise<void>;
}

/** Inside a test file: a uniquely named database cloned from the template. */
export async function testDatabase(opts?: { template?: string }): Promise<TestDatabase> {
  const { host, port } = inject("wbPg");
  const pg = attachPostgres(host, port);
  const name = `t_${randomBytes(8).toString("hex")}`;
  await pg.createDatabase(name, opts);
  return {
    name,
    url: (role) => pg.url(name, role),
    drop: () => pg.dropDatabase(name),
  };
}
