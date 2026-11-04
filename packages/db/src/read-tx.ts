import { withTenantTx } from "./tx.ts";

import type { TenantCtx, TxHandle } from "./tx.ts";
import type pg from "pg";

/** Node socket errors that mean "could not reach the server" (not "the server refused this query"). */
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"]);

/**
 * True when the replica could not serve the request at all (down, restarting, out of connections, network), as opposed
 * to a failure of the query itself. Only the first kind may be retried on the primary: a bad query would fail there too,
 * and running it twice would hide the bug.
 */
export function isReplicaUnavailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (NETWORK_CODES.has(code)) return true;
    // 08 connection exception, 57P01-57P03 admin shutdown / crash / cannot connect now, 53300 too many connections
    if (code.startsWith("08") || code.startsWith("57P0") || code === "53300") return true;
  }
  const message = (err as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    /connection terminated|timeout exceeded when trying to connect|server closed the connection/i.test(
      message,
    )
  );
}

/**
 * A tenant read that prefers the read replica (heavy, lag-tolerant queries such as reports) and falls back to the
 * primary once when the replica is unreachable, so a replica outage slows reports down instead of breaking them. Without
 * a replica it is exactly `withTenantTx(primary, ...)`. Never use it for data a user just wrote.
 */
export async function withReadTx<T>(
  primary: pg.Pool,
  replica: pg.Pool | undefined,
  ctx: TenantCtx,
  fn: (tx: TxHandle) => Promise<T>,
  onFallback?: (err: unknown) => void,
): Promise<T> {
  if (replica === undefined) return withTenantTx(primary, ctx, fn);
  try {
    return await withTenantTx(replica, ctx, fn);
  } catch (err) {
    if (!isReplicaUnavailable(err)) throw err;
    onFallback?.(err);
    return withTenantTx(primary, ctx, fn);
  }
}
