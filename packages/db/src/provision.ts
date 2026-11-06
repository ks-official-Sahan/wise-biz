/** The service roles and the secret name each one's connection string is kept under. */
export const SERVICE_ROLES = [
  { role: "wb_migrator", variable: "DATABASE_MIGRATOR_URL", pooled: false, limit: undefined },
  { role: "wb_app", variable: "DATABASE_URL", pooled: true, limit: 200 },
  { role: "wb_worker", variable: "DATABASE_WORKER_URL", pooled: false, limit: 50 },
  { role: "wb_chainer", variable: "DATABASE_CHAINER_URL", pooled: false, limit: 20 },
  { role: "wb_identity", variable: "DATABASE_IDENTITY_URL", pooled: true, limit: 50 },
] as const;

export type DbVariable = (typeof SERVICE_ROLES)[number]["variable"] | "DATABASE_READ_URL";
export type ServiceRole = (typeof SERVICE_ROLES)[number]["role"];
export type Passwords = Readonly<Record<ServiceRole, string>>;

/** Per-role timeouts, the same values as infra/neon/provision-roles.sql. */
const TIMEOUTS: Readonly<Record<string, readonly [string, string]>> = {
  wb_app: ["15s", "30s"],
  wb_worker: ["30s", "60s"],
  wb_chainer: ["30s", "60s"],
  wb_identity: ["15s", "30s"],
};

/** Extensions the migrations rely on (infra/docker/postgres/init/002-extensions.sql). Created by the owner: the migrator is not a superuser. */
export const EXTENSIONS = ["pgcrypto", "pg_trgm", "vector", "pg_stat_statements"] as const;

/** The databases a provisioning run must never be pointed at: the application lives in `wise_biz`. */
export const WRONG_DATABASES = ["neondb", "postgres", "template1"] as const;

/**
 * Step 1, once per Neon branch: the five roles and their per-role timeouts (the role part of
 * infra/neon/provision-roles.sql). Passwords are escaped by the caller's `literal` (`pg` gives `escapeLiteral`), because
 * CREATE ROLE cannot take bind parameters.
 */
export function roleStatements(
  passwords: Passwords,
  quote: { literal: (s: string) => string },
): string[] {
  const out: string[] = [];
  for (const r of SERVICE_ROLES) {
    const limit = r.limit === undefined ? "" : ` CONNECTION LIMIT ${String(r.limit)}`;
    out.push(
      `CREATE ROLE ${r.role} WITH LOGIN PASSWORD ${quote.literal(passwords[r.role])} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS${limit}`,
    );
  }
  for (const [role, [statement, idle]] of Object.entries(TIMEOUTS)) {
    out.push(`ALTER ROLE ${role} SET statement_timeout = '${statement}'`);
    out.push(`ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '${idle}'`);
  }
  return out;
}

/**
 * Step 2, for the database `wise_biz`, run while connected to it as the owner; safe to repeat. It is what the local Docker
 * setup does in 001-roles-db.sql and 002-extensions.sql: extensions, the database owned by the migrator and closed to
 * everyone else, the public schema owned by the migrator, and default privileges so that the app role gets
 * DML (never DDL) on every table and sequence the migrator creates later.
 */
export function databaseStatements(
  dbname: string,
  quote: { identifier: (s: string) => string },
): string[] {
  const db = quote.identifier(dbname);
  const all = SERVICE_ROLES.map((r) => r.role).join(", ");
  return [
    ...EXTENSIONS.map((e) => `CREATE EXTENSION IF NOT EXISTS ${e}`),
    `ALTER DATABASE ${db} OWNER TO wb_migrator`,
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${db} TO ${all}`,
    `REVOKE TEMPORARY ON DATABASE ${db} FROM wb_app`,
    `REVOKE TEMPORARY ON DATABASE ${db} FROM PUBLIC`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    "GRANT USAGE ON SCHEMA public TO wb_app",
    "ALTER SCHEMA public OWNER TO wb_migrator",
    "ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wb_app",
    "ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator GRANT USAGE, SELECT ON SEQUENCES TO wb_app",
  ];
}

/** `ep-name.region.aws.neon.tech` -> the same endpoint behind Neon's pooler: `ep-name-pooler.region.aws.neon.tech`. */
export function pooledHost(host: string): string {
  const [endpoint = host, ...rest] = host.replace("-pooler.", ".").split(".");
  return [`${endpoint}-pooler`, ...rest].join(".");
}

export const directHost = (host: string): string => host.replace("-pooler.", ".");

/**
 * The connection strings per variable name, from any Neon connection string of the project (pooled or direct). The app and
 * identity roles use the pooled host; the migrator, worker and chainer roles use the direct host because they take session
 * advisory locks (docs/runbooks/neon.md). `readHost` is the read replica's endpoint host; it gives DATABASE_READ_URL.
 * Passwords are base64url, so they need no escaping in a URL.
 */
export function connectionUrls(
  anyNeonUrl: string,
  dbname: string,
  passwords: Passwords,
  readHost?: string,
): Partial<Record<DbVariable, string>> {
  const host = new URL(anyNeonUrl).hostname;
  const url = (role: ServiceRole, h: string): string =>
    `postgresql://${role}:${passwords[role]}@${h}/${dbname}?sslmode=verify-full`;
  const out: Partial<Record<DbVariable, string>> = {};
  for (const r of SERVICE_ROLES) {
    out[r.variable] = url(r.role, r.pooled ? pooledHost(host) : directHost(host));
  }
  if (readHost !== undefined && readHost !== "")
    out.DATABASE_READ_URL = url("wb_app", pooledHost(readHost));
  return out;
}
