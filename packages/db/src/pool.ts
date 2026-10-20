import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type Db = NodePgDatabase;

export interface PoolOptions {
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
  idleInTxTimeoutMs?: number;
}

/** Pool factory. Timeouts are set per connection via startup options (no extra round trip). */
export function createPool(url: string, opts: PoolOptions = {}): pg.Pool {
  const statement = String(Math.trunc(opts.statementTimeoutMs ?? 15_000));
  const idleTx = String(Math.trunc(opts.idleInTxTimeoutMs ?? 30_000));
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "wise-biz",
    options: `-c statement_timeout=${statement} -c idle_in_transaction_session_timeout=${idleTx}`,
  });
  // Idle clients can die (failover, terminate); without a listener Node would crash. pg evicts them.
  pool.on("error", () => undefined);
  return pool;
}

/** Drizzle instance bound to a pool (typed tables, no hidden queries). */
export function createDb(pool: pg.Pool): Db {
  return drizzle(pool);
}
