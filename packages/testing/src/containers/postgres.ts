import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

export const POSTGRES_IMAGE = "pgvector/pgvector:0.8.7-pg18-trixie";
export const BASE_TEMPLATE = "wb_base";

export type PgRole = "admin" | "migrator" | "app";

export interface PgHarness {
  host: string;
  port: number;
  url(db: string, role?: PgRole): string;
  createDatabase(name: string, opts?: { template?: string }): Promise<void>;
  dropDatabase(name: string): Promise<void>;
  markTemplate(name: string): Promise<void>;
  stop(): Promise<void>;
}

const NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
// Arbitrary constant: serialises CREATE DATABASE ... TEMPLATE across all connections.
const CREATE_LOCK_KEY = 7_706_001;

// DEV/TEST ONLY credentials, identical to infra/docker/postgres/init/001-roles-db.sql.
const CREDENTIALS: Record<PgRole, { user: string; password: string }> = {
  admin: { user: "postgres", password: "postgres" },
  migrator: { user: "wb_migrator", password: "wb_migrator" },
  app: { user: "wb_app", password: "wb_app" },
};

const INIT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../infra/docker/postgres/init",
);

function ident(name: string): string {
  if (!NAME_RE.test(name)) throw new Error(`invalid database name: ${name}`);
  return `"${name}"`;
}

/** Harness over an already-running server (used by test files via the provided host/port). */
export function attachPostgres(
  host: string,
  port: number,
  stop: () => Promise<void> = () => Promise.resolve(),
): PgHarness {
  const url = (db: string, role: PgRole = "app"): string => {
    const { user, password } = CREDENTIALS[role];
    return `postgres://${user}:${password}@${host}:${String(port)}/${db}`;
  };

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url("postgres", "admin") });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  return {
    host,
    port,
    url,
    createDatabase: (name, opts) =>
      withAdmin(async (c) => {
        const sql = `CREATE DATABASE ${ident(name)} TEMPLATE ${ident(opts?.template ?? BASE_TEMPLATE)} OWNER wb_migrator`;
        await c.query("SELECT pg_advisory_lock($1)", [CREATE_LOCK_KEY]);
        try {
          await c.query(sql);
          // CREATE DATABASE does not copy the template's ACL: re-apply the DB-level grants from 002-extensions.sql.
          const q = ident(name);
          await c.query(
            `REVOKE ALL ON DATABASE ${q} FROM PUBLIC; GRANT CONNECT ON DATABASE ${q} TO wb_app; REVOKE TEMPORARY ON DATABASE ${q} FROM wb_app`,
          );
        } finally {
          await c.query("SELECT pg_advisory_unlock($1)", [CREATE_LOCK_KEY]);
        }
      }),
    dropDatabase: (name) =>
      withAdmin(async (c) => {
        await c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
      }),
    markTemplate: (name) =>
      withAdmin(async (c) => {
        // Template sources must have no other sessions during CREATE DATABASE.
        await c.query(`ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE true`);
      }),
    stop,
  };
}

/** Build wb_base: same roles/extensions/grants as the compose init scripts. */
async function buildBase(harness: PgHarness): Promise<void> {
  const admin = new pg.Client({ connectionString: harness.url("postgres", "admin") });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${ident(BASE_TEMPLATE)} OWNER wb_migrator`);
  } finally {
    await admin.end();
  }
  // Reuse 002-extensions.sql verbatim, minus the psql-only \connect, retargeted at wb_base.
  const sql = readFileSync(resolve(INIT_DIR, "002-extensions.sql"), "utf8")
    .replace(/^\\connect .*$/m, "")
    .replaceAll("wise_biz", BASE_TEMPLATE);
  const base = new pg.Client({ connectionString: harness.url(BASE_TEMPLATE, "admin") });
  await base.connect();
  try {
    await base.query(sql);
  } finally {
    await base.end();
  }
  await harness.markTemplate(BASE_TEMPLATE);
}

export async function startPostgres(): Promise<PgHarness> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername(CREDENTIALS.admin.user)
    .withPassword(CREDENTIALS.admin.password)
    .withDatabase("postgres")
    .withCommand([
      "postgres",
      "-c",
      "shared_preload_libraries=pg_stat_statements",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ])
    .withCopyFilesToContainer([
      {
        source: resolve(INIT_DIR, "001-roles-db.sql"),
        target: "/docker-entrypoint-initdb.d/001-roles-db.sql",
      },
    ])
    .start();
  const harness = attachPostgres(container.getHost(), container.getPort(), async () => {
    await container.stop();
  });
  try {
    await buildBase(harness);
  } catch (error) {
    await harness.stop();
    throw error;
  }
  return harness;
}
