import { drizzle } from "drizzle-orm/node-postgres";

import type { Db } from "./pool.ts";
import type pg from "pg";

export type TenantCtx = Readonly<{ tenantId: string; userId?: string; requestId: string }>;
export type PlatformCtx = Readonly<{ reason: string; requestId: string; actorId: string }>;

export interface TxHandle {
  /** Drizzle bound to the open transaction's client. */
  readonly db: Db;
  /** Raw parameterised query on the same transaction. */
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}

const SETTINGS_SQL =
  "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.request_id', $3, true)";
const PLATFORM_SQL =
  "select set_config('app.platform', 'on', true), set_config('app.platform_reason', $1, true), set_config('app.actor_id', $2, true), set_config('app.request_id', $3, true)";

async function run<T>(
  pool: pg.Pool,
  settingsSql: string,
  params: string[],
  fn: (tx: TxHandle) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseErr: Error | undefined;
  // A backend killed mid-transaction emits 'error' on the checked-out client; surface it via query rejection only.
  const onError = (): void => undefined;
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    // One round trip; is_local=true so settings die with the transaction (pool-safe).
    await client.query(settingsSql, params);
    const tx: TxHandle = {
      db: drizzle(client),
      query: (sql, p) => client.query(sql, p),
    };
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      releaseErr = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.off("error", onError);
    client.release(releaseErr); // truthy arg destroys the connection
  }
}

/** BEGIN -> set tenant settings (local) -> fn -> COMMIT; ROLLBACK on throw. */
export async function withTenantTx<T>(
  pool: pg.Pool,
  ctx: TenantCtx,
  fn: (tx: TxHandle) => Promise<T>,
): Promise<T> {
  if (!isUuidV7(ctx.tenantId)) throw new Error("withTenantTx: tenantId must be a UUIDv7");
  return run(pool, SETTINGS_SQL, [ctx.tenantId, ctx.userId ?? "", ctx.requestId], fn);
}

/**
 * Platform-only access. Does NOT set app.tenant_id, so tenant tables return zero rows.
 * Platform tables use a separate policy keyed on `current_setting('app.platform', true) = 'on'`.
 * `reason` and `actorId` are exposed as app.platform_reason / app.actor_id for the audit row
 * the caller must write in the same transaction.
 */
export async function withPlatformTx<T>(
  pool: pg.Pool,
  ctx: PlatformCtx,
  fn: (tx: TxHandle) => Promise<T>,
): Promise<T> {
  if (ctx.reason.trim() === "") throw new Error("withPlatformTx: reason is required");
  return run(pool, PLATFORM_SQL, [ctx.reason, ctx.actorId, ctx.requestId], fn);
}
