import { AsyncLocalStorage } from "node:async_hooks";

import type pg from "pg";

interface Scope {
  count: number;
  statements: string[];
}

const als = new AsyncLocalStorage<Scope>();
const PATCHED = Symbol.for("wise-biz.db.instrumented");

/** Transaction control and tenant-setting statements are not "real" queries. */
const HOUSEKEEPING = /^\s*(begin|commit|rollback|start transaction|select set_config\()/i;

export function isHousekeeping(sql: string): boolean {
  return HOUSEKEEPING.test(sql);
}

function textOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object" && "text" in arg && typeof arg.text === "string")
    return arg.text;
  return undefined;
}

/**
 * TEST / DIAGNOSTICS ONLY. Recorded statements may contain inlined literals (PII, secrets), so never log
 * or ship them in production.
 *
 * Patch every client the pool creates (via its 'connect' event) so queries report to the active
 * countQueries scope, whether issued with pool.query, pool.connect() or drizzle.
 * Call right after createPool, before first use: clients that already exist are not patched.
 * BEGIN/COMMIT/ROLLBACK/set_config housekeeping is excluded from the count. Idempotent.
 */
export function instrumentPool(pool: pg.Pool): void {
  const marked = pool as unknown as Record<symbol, boolean>;
  if (marked[PATCHED]) return;
  marked[PATCHED] = true;
  pool.on("connect", (client) => {
    const c = client as unknown as { query: (...a: unknown[]) => unknown };
    const orig = c.query.bind(client);
    c.query = (...args: unknown[]) => {
      const scope = als.getStore();
      const text = textOf(args[0]);
      if (scope && text !== undefined && !isHousekeeping(text)) {
        scope.count += 1;
        scope.statements.push(text);
      }
      return orig(...args);
    };
  });
}

/** Run fn in an isolated counting scope (AsyncLocalStorage: concurrent scopes do not mix). */
export async function countQueries<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; count: number; statements: string[] }> {
  const scope: Scope = { count: 0, statements: [] };
  const result = await als.run(scope, fn);
  return { result, count: scope.count, statements: scope.statements };
}
