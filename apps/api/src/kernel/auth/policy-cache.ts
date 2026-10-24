import { isValidConditions, matrixFromRows } from "@wise-biz/policy";
import { z } from "zod";

import { withTimeout } from "./timeout.ts";

import type { KernelRedis, PolicyRowsLoader } from "./types.ts";
import type { PermissionCatalog, PolicyMatrix, PolicyRow } from "@wise-biz/policy";
import type { Logger } from "pino";

export const POLICY_LRU_MAX = 1000;
export const POLICY_REDIS_TTL_SECONDS = 3600;
const REDIS_TIMEOUT_MS = 200;

/** Redis key (tenant-scoped, versioned): a permissions_version bump makes the old entry unreachable. */
export const policyKey = (tenantId: string, version: number): string =>
  `t:${tenantId}:perm:v${String(version)}`;

const StoredRows = z.array(
  z.object({ role: z.string(), permission: z.string(), conditions: z.unknown().optional() }),
);

/** Re-validate a Redis entry into PolicyRow[]. Anything malformed (shape or conditions) is a miss, never trusted. */
function parseRows(raw: string): PolicyRow[] | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredRows.safeParse(json);
  if (!parsed.success) return null;
  const rows: PolicyRow[] = [];
  for (const { role, permission, conditions } of parsed.data) {
    if (conditions === undefined) rows.push({ role, permission });
    else if (isValidConditions(conditions)) rows.push({ role, permission, conditions });
    else return null;
  }
  return rows;
}

export interface PolicyMatrixCache {
  matrixFor(tenantId: string, version: number, requestId: string): Promise<PolicyMatrix>;
}

export interface PolicyCacheOptions {
  catalog: PermissionCatalog;
  loadRows: PolicyRowsLoader;
  redis?: Pick<KernelRedis, "get" | "set"> | undefined;
  logger?: Logger | undefined;
  lruMax?: number;
  redisTimeoutMs?: number;
}

/**
 * Per-request policy matrix. Layers: in-process LRU (tenant+version) -> Redis `t:{tenant}:perm:v{n}` (TTL 1 h) -> DB.
 * Redis errors/timeouts fall through to the DB and never fail a read. Concurrent misses share one load (single flight).
 * Data structure: Map insertion order is the LRU order (delete + set on hit), O(1) for everything.
 */
export function createPolicyMatrixCache(opts: PolicyCacheOptions): PolicyMatrixCache {
  const max = opts.lruMax ?? POLICY_LRU_MAX;
  const timeoutMs = opts.redisTimeoutMs ?? REDIS_TIMEOUT_MS;
  const lru = new Map<string, PolicyMatrix>();
  const inflight = new Map<string, Promise<PolicyMatrix>>();

  const remember = (key: string, matrix: PolicyMatrix): void => {
    lru.delete(key);
    lru.set(key, matrix);
    if (lru.size > max) {
      const oldest = lru.keys().next();
      if (!oldest.done) lru.delete(oldest.value);
    }
  };
  const warn = (err: unknown, op: string): void => {
    opts.logger?.warn({ err, op }, "policy cache redis error; falling back to database");
  };

  async function load(tenantId: string, version: number, requestId: string): Promise<PolicyMatrix> {
    const rkey = policyKey(tenantId, version);
    if (opts.redis) {
      try {
        const hit = await withTimeout(opts.redis.get(rkey), timeoutMs, "policy cache get");
        if (hit !== null) {
          const rows = parseRows(hit);
          if (rows !== null) return matrixFromRows(opts.catalog, rows);
        }
      } catch (err) {
        warn(err, "get");
      }
    }
    const rows = await opts.loadRows(tenantId, requestId);
    if (opts.redis) {
      try {
        await withTimeout(
          opts.redis.set(rkey, JSON.stringify(rows), POLICY_REDIS_TTL_SECONDS),
          timeoutMs,
          "policy cache set",
        );
      } catch (err) {
        warn(err, "set");
      }
    }
    return matrixFromRows(opts.catalog, rows);
  }

  return {
    matrixFor(tenantId, version, requestId) {
      const key = `${tenantId}:${String(version)}`;
      const cached = lru.get(key);
      if (cached !== undefined) {
        remember(key, cached); // refresh recency
        return Promise.resolve(cached);
      }
      let pending = inflight.get(key);
      if (pending === undefined) {
        pending = load(tenantId, version, requestId)
          .then((m) => {
            remember(key, m);
            return m;
          })
          .finally(() => {
            inflight.delete(key);
          });
        inflight.set(key, pending);
      }
      return pending;
    },
  };
}
