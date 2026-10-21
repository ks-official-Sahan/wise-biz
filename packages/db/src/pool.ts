import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type Db = NodePgDatabase;

export interface PoolOptions {
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
  idleInTxTimeoutMs?: number;
  /** Max wait for a connection (checkout + connect). Default 5000. */
  connectionTimeoutMs?: number;
  /** Explicit TLS config; satisfies the production TLS requirement. */
  ssl?: pg.PoolConfig["ssl"];
  /** Override production detection (default: NODE_ENV === "production"). Mainly for tests. */
  production?: boolean;
  /** Called when an idle client errors (failover, terminate). Default: ignored. Pass a logger.warn wrapper. */
  onError?: (err: Error) => void;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLocalOrSocket(url: string): boolean {
  const u = new URL(url);
  const host = decodeURIComponent(u.hostname)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  const hostParam = u.searchParams.get("host") ?? "";
  if (host === "" && hostParam.startsWith("/")) return true; // unix socket via ?host=
  return host.startsWith("/") || LOCAL_HOSTS.has(host);
}

function assertTls(url: string, ssl: unknown): void {
  if (ssl !== undefined && ssl !== false) return;
  let local: boolean;
  let mode: string | null;
  try {
    local = isLocalOrSocket(url);
    mode = new URL(url).searchParams.get("sslmode");
  } catch {
    throw new Error("createPool: unparsable connection URL (production needs a postgres:// URL)");
  }
  if (local || mode === "verify-full" || mode === "verify-ca") return;
  throw new Error(
    "createPool: production requires verified TLS for non-local hosts (sslmode=verify-full|verify-ca in the URL, or opts.ssl)",
  );
}

/**
 * Pool factory. Timeouts are set per connection via startup options (no extra round trip).
 * In production, a non-local host must use verified TLS or this throws.
 */
export function createPool(url: string, opts: PoolOptions = {}): pg.Pool {
  const production = opts.production ?? process.env.NODE_ENV === "production";
  if (production) assertTls(url, opts.ssl);
  const statement = String(Math.trunc(opts.statementTimeoutMs ?? 15_000));
  const idleTx = String(Math.trunc(opts.idleInTxTimeoutMs ?? 30_000));
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "wise-biz",
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 5000,
    ...(opts.ssl === undefined ? {} : { ssl: opts.ssl }),
    options: `-c statement_timeout=${statement} -c idle_in_transaction_session_timeout=${idleTx}`,
  });
  // Idle clients can die (failover, terminate); without a listener Node would crash. pg evicts them.
  pool.on("error", (err: Error) => {
    opts.onError?.(err);
  });
  return pool;
}

/** Drizzle instance bound to a pool (typed tables, no hidden queries). */
export function createDb(pool: pg.Pool): Db {
  return drizzle(pool);
}
