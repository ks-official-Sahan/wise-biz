import { chainTenant, listTenantsWithUnchained } from "@wise-biz/db";

import { createStopper } from "./loop.ts";
import { errorInfo, safely } from "./types.ts";

import type { AuditLogger, AuditOnMetric } from "./types.ts";
import type pg from "pg";

export type ChainerOptions = Readonly<{
  /** Pool connected as wb_chainer. */
  pool: pg.Pool;
  logger: AuditLogger;
  intervalMs?: number;
  tenantsPerTick?: number;
  batch?: number;
  onMetric?: AuditOnMetric | undefined;
}>;

export interface Chainer {
  /** One pass over up to `tenantsPerTick` tenants. Returns rows chained. Never throws. */
  tick(): Promise<number>;
  start(): void;
  /** Abort the sleep and wait for the in-flight tick. */
  stop(): Promise<void>;
}

const MAX_ERROR_BACKOFF_MS = 10_000;

/**
 * Async audit chainer. Each pass: tenants with unchained rows (index skip-scan) -> chainTenant each,
 * sequentially (one short transaction per tenant, head row lock inside chainTenant). A failing tenant is
 * logged + counted and skipped; it never stops the pass or the loop. When the pass was saturated (a full batch
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

  const metric = (name: Parameters<AuditOnMetric>[0], value = 1, labels = {}): void => {
    safely(() => onMetric?.(name, value, labels));
  };

  async function tick(): Promise<number> {
    saturated = false;
    let tenants: string[];
    try {
      tenants = await listTenantsWithUnchained(pool, tenantsPerTick);
    } catch (e) {
      safely(() => {
        logger.error({ err: errorInfo(e) }, "audit chainer: listing tenants failed");
      });
      metric("audit_chain_loop_error");
      throw e;
    }
    let total = 0;
    for (const tenantId of tenants) {
      if (stopper.isStopping()) break;
      try {
        const { chained } = await chainTenant(pool, tenantId, { batch });
        total += chained;
        if (chained >= batch) saturated = true;
      } catch (e) {
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
