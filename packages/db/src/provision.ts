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

/**
 * The statements of infra/neon/provision-roles.sql, with the passwords and the database name escaped by the caller's
 * functions (`pg` gives `escapeLiteral` and `escapeIdentifier`), because CREATE ROLE cannot take bind parameters.
 * Keep this and the .sql file in step: both are the role definition of ADR 0017.
 */
export function provisionStatements(
  dbname: string,
  passwords: Passwords,
  quote: { literal: (s: string) => string; identifier: (s: string) => string },
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
  const db = quote.identifier(dbname);
  out.push(`ALTER DATABASE ${db} OWNER TO wb_migrator`);
  out.push(`REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC`);
  out.push(`GRANT CONNECT ON DATABASE ${db} TO ${SERVICE_ROLES.map((r) => r.role).join(", ")}`);
  return out;
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
