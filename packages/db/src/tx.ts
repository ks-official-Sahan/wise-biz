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
/** Internal: shared by withTenantTx and the platform subpath. Not exported from the package root. */
export async function run<T>(
  pool: pg.Pool,
  settingsSql: string,
  params: string[],
  fn: (tx: TxHandle) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseErr: Error | undefined;
  let closed = false;
  // A backend killed mid-transaction emits 'error' on the checked-out client; surface it via query rejection only.
  const onError = (): void => undefined;
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    // One round trip; is_local=true so settings die with the transaction (pool-safe).
    await client.query(settingsSql, params);
    // Handle dies with the tx: a leaked reference must not run on a client that is already back in the pool.
    const assertOpen = (): void => {
      if (closed)
        throw new Error("transaction handle is closed (used after the transaction ended)");
    };
    const guarded = new Proxy(client, {
      get(target, prop) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            try {
              assertOpen();
            } catch (e) {
              return Promise.reject(e instanceof Error ? e : new Error(String(e)));
            }
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const v: unknown = Reflect.get(target, prop, target);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const tx: TxHandle = {
      db: drizzle(guarded),
      query: (sql, p) => {
        try {
          assertOpen();
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
        return client.query(sql, p);
      },
    };
    let result: T;
    try {
      result = await fn(tx);
    } finally {
      closed = true;
    }
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
