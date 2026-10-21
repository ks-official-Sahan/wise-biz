import { chainTenant } from "@wise-biz/db";

import { createStopper } from "./loop.ts";
import { errorInfo, safely, systemClock } from "./types.ts";

import type { AuditLogger, AuditOnMetric, Clock } from "./types.ts";
import type pg from "pg";

export type ChainerOptions = Readonly<{
  /** Pool connected as wb_chainer. */
  pool: pg.Pool;
  logger: AuditLogger;
  intervalMs?: number;
  tenantsPerTick?: number;
  batch?: number;
  onMetric?: AuditOnMetric | undefined;
  clock?: Clock;
}>;

export interface Chainer {
  /** One pass over up to `tenantsPerTick` tenants. Returns rows chained. Never throws. */
  tick(): Promise<number>;
  start(): void;
  /** Abort the sleep and wait for the in-flight tick. */
  stop(): Promise<void>;
}

const MAX_ERROR_BACKOFF_MS = 10_000;
const TENANT_BACKOFF_BASE_MS = 1000;
const TENANT_BACKOFF_MAX_MS = 300_000;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Skip-scan of tenants with unchained rows strictly after `after`, excluding backed-off tenants. One index probe
 * per returned tenant on the partial work-queue index (hash IS NULL); `<> all('{}')` is true for an empty list.
 */
async function listTenants(
  pool: pg.Pool,
  after: string,
  exclude: readonly string[],
  limit: number,
): Promise<string[]> {
  const res = await pool.query<{ tenant_id: string }>(
    `with recursive t(tenant_id) as (
       (select tenant_id from audit.audit_log
         where hash is null and tenant_id > $1::uuid and tenant_id <> all($2::uuid[]) order by tenant_id limit 1)
       union all
       select (select a.tenant_id from audit.audit_log a
                where a.hash is null and a.tenant_id > t.tenant_id and a.tenant_id <> all($2::uuid[])
                order by a.tenant_id limit 1)
       from t where t.tenant_id is not null
     )
     select tenant_id::text from t where tenant_id is not null limit $3`,
    [after, exclude, limit],
  );
  return res.rows.map((r) => r.tenant_id);
}

/**
 * Async audit chainer. Each pass: tenants with unchained rows (index skip-scan) -> chainTenant each,
 * sequentially (one short transaction per tenant, head row lock inside chainTenant). A failing tenant is
 * logged + counted and skipped; it never stops the pass or the loop. Fairness: passes rotate through tenants with an
 * `after` cursor (wrapping at the end), and a failing tenant is backed off exponentially (1 s .. 5 min, in memory) and
 * excluded from listing, so failing tenants cannot occupy the page slots of healthy ones. When the pass was saturated (a full batch
 * for some tenant, or a full tenant page) the next pass starts immediately, otherwise the loop sleeps.
 */
export function createAuditChainer(opts: ChainerOptions): Chainer {
  const { pool, logger, onMetric } = opts;
  const intervalMs = opts.intervalMs ?? 2000;
  const tenantsPerTick = opts.tenantsPerTick ?? 50;
  const batch = opts.batch ?? 1000;
  const stopper = createStopper();
  let loop: Promise<void> | undefined;
  let saturated = false;
  const clock = opts.clock ?? systemClock;
  let cursor = NIL_UUID;
  const backoff = new Map<string, { failures: number; until: number }>();

  const metric = (name: Parameters<AuditOnMetric>[0], value = 1, labels = {}): void => {
    safely(() => onMetric?.(name, value, labels));
  };

  async function tick(): Promise<number> {
    saturated = false;
    const now = clock.now();
    const exclude: string[] = [];
    for (const [id, b] of backoff) if (b.until > now) exclude.push(id);
    let tenants: string[];
    try {
      tenants = await listTenants(pool, cursor, exclude, tenantsPerTick);
      if (tenants.length === 0 && cursor !== NIL_UUID) {
        // end of the ring: wrap around within the same pass
        cursor = NIL_UUID;
        tenants = await listTenants(pool, cursor, exclude, tenantsPerTick);
      }
    } catch (e) {
      safely(() => {
        logger.error({ err: errorInfo(e) }, "audit chainer: listing tenants failed");
      });
      metric("audit_chain_loop_error");
      throw e;
    }
    const lastListed = tenants[tenants.length - 1];
    cursor = lastListed !== undefined && tenants.length >= tenantsPerTick ? lastListed : NIL_UUID;
    let total = 0;
    for (const tenantId of tenants) {
      if (stopper.isStopping()) break;
      try {
        const { chained } = await chainTenant(pool, tenantId, { batch });
        total += chained;
        backoff.delete(tenantId);
        if (chained >= batch) saturated = true;
      } catch (e) {
        const failures = (backoff.get(tenantId)?.failures ?? 0) + 1;
        backoff.set(tenantId, {
          failures,
          until:
            clock.now() +
            Math.min(
              TENANT_BACKOFF_MAX_MS,
              TENANT_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 20),
            ),
        });
        safely(() => {
          logger.error({ tenantId, err: errorInfo(e) }, "audit chainer: tenant failed");
        });
        metric("audit_chain_tenant_error", 1, { tenantId });
      }
    }
    if (total > 0) metric("audit_chain_rows", total);
    if (tenants.length >= tenantsPerTick && total > 0) saturated = true;
    return total;
  }

  async function main(): Promise<void> {
    let failures = 0;
    while (!stopper.isStopping()) {
      try {
        await tick();
        failures = 0;
        if (saturated) continue;
        await stopper.sleep(intervalMs);
      } catch {
        failures += 1;
        await stopper.sleep(
          Math.min(MAX_ERROR_BACKOFF_MS, intervalMs * 2 ** Math.min(failures, 5)),
        );
      }
    }
  }

  return {
    tick: async () => {
      try {
        return await tick();
      } catch {
        return 0;
      }
    },
    start() {
      loop ??= main();
    },
    async stop() {
      stopper.stop();
      await loop;
    },
  };
}
