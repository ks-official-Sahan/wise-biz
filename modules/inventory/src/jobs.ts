import { withTenantTx } from "@wise-biz/db";
import { z } from "zod";

import { fromQty4, NO_BATCH, normQty, toQty4 } from "./domain/qty.ts";
import { BalanceLowV1, BatchExpiringV1, DriftDetectedV1, INVENTORY_TOPIC } from "./events.ts";

import type { OutboxEvent } from "@wise-biz/db";
import type pg from "pg";
import type { PoolClient } from "pg";

/**
 * Inventory jobs for the workers (ADR 0012, ADR 0013). The scheduled ones take a session advisory lock so several
 * worker replicas never run the same job at once; every write happens in a tenant-scoped transaction.
 */
export interface JobDeps {
  /** wb_worker pool. */
  readonly pool: pg.Pool;
  readonly ids: { uuidv7(): string };
  readonly now: () => Date;
}

function jobEvent(
  deps: JobDeps,
  def: { type: string; version: number; parse(v: unknown): { id: string } },
  tenantId: string,
  subject: string,
  data: unknown,
  variantId: string,
): OutboxEvent {
  const e = def.parse({
    id: deps.ids.uuidv7(),
    type: def.type,
    version: def.version,
    source: "workers/inventory",
    tenantId,
    subject,
    time: deps.now().toISOString(),
    correlationId: `job-${def.type}`,
    actor: { type: "system", id: "inventory-jobs" },
    data,
  });
  return {
    id: e.id,
    topic: INVENTORY_TOPIC,
    key: `${tenantId}:${variantId}`,
    type: def.type,
    version: def.version,
    payload: e,
  };
}

/**
 * Appends events in the caller's tenant transaction (consumer client or withTenantTx handle). The tenant_isolation
 * WITH CHECK on infra.outbox applies (ADR 0012); wb_worker holds column INSERT only.
 */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}
async function appendOutbox(tx: Queryable, events: readonly OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  const tenantId = (events[0]?.payload as { tenantId: string }).tenantId;
  await tx.query(
    `insert into infra.outbox (tenant_id, id, topic, key, type, version, payload)
     select $1, e.id, e.topic, e.key, e.type, e.version, e.payload
     from jsonb_to_recordset($2::jsonb) as e(id uuid, topic text, key text, type text, version int, payload jsonb)`,
    [tenantId, JSON.stringify(events)],
  );
}

/** Runs `fn` only if no other session holds the job's lock; returns undefined when skipped. */
export async function exclusive<T>(
  pool: pg.Pool,
  name: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const client = await pool.connect();
  try {
    const r = await client.query<{ ok: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as ok",
      [name],
    );
    if (r.rows[0]?.ok !== true) return undefined;
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [name]);
    }
  } finally {
    client.release();
  }
}

/** Keeps months_back..months_ahead ledger partitions in place (SECURITY DEFINER function). */
export async function ensureInventoryPartitions(
  pool: pg.Pool,
  monthsBack = 12,
  monthsAhead = 3,
): Promise<number> {
  const r = await pool.query<{ n: number }>("select inventory.ensure_partitions($1, $2) as n", [
    monthsBack,
    monthsAhead,
  ]);
  return r.rows[0]?.n ?? 0;
}

// --- Low stock (event-driven) ---

const MovementRecorded = z.object({
  tenantId: z.string(),
  data: z.object({
    variantId: z.string(),
    balances: z.array(z.object({ locationId: z.string() })),
  }),
});

/**
 * On every movement of a SKU: compare on-hand (summed over batches) with each location's threshold. Fires
 * inventory.balance.low once when it drops below min_qty and re-arms when stock recovers (low_since is the debounce
 * state), so a busy SKU does not alert on every sale. Runs in the consumer's tenant transaction.
 */
export async function evaluateLowStock(
  client: PoolClient,
  deps: JobDeps,
  payload: unknown,
): Promise<number> {
  const e = MovementRecorded.parse(payload);
  const locations = [...new Set(e.data.balances.map((b) => b.locationId))].sort();
  if (locations.length === 0) return 0;
  const r = await client.query<{
    location_id: string;
    on_hand: string;
    min_qty: string;
    max_qty: string | null;
    low_since: Date | null;
  }>(
    `select t.location_id, coalesce(sum(s.qty), 0)::text as on_hand, t.min_qty::text, t.max_qty::text, t.low_since
     from inventory.stock_thresholds t
     left join inventory.stock_balances s
       on s.tenant_id = t.tenant_id and s.location_id = t.location_id and s.variant_id = t.variant_id
     where t.tenant_id = $1 and t.variant_id = $2 and t.location_id = any($3::uuid[])
     group by t.location_id, t.min_qty, t.max_qty, t.low_since
     order by t.location_id`,
    [e.tenantId, e.data.variantId, locations],
  );
  const fire = r.rows.filter((x) => toQty4(x.on_hand) < toQty4(x.min_qty) && x.low_since === null);
  const rearm = r.rows.filter(
    (x) => toQty4(x.on_hand) >= toQty4(x.min_qty) && x.low_since !== null,
  );
  const flip = async (rows: typeof r.rows, value: Date | null) => {
    if (rows.length === 0) return;
    await client.query(
      `update inventory.stock_thresholds set low_since = $4
       where tenant_id = $1 and variant_id = $2 and location_id = any($3::uuid[])`,
      [e.tenantId, e.data.variantId, rows.map((x) => x.location_id), value],
    );
  };
  await flip(fire, deps.now());
  await flip(rearm, null);
  await appendOutbox(
    client,
    fire.map((x) =>
      jobEvent(
        deps,
        BalanceLowV1,
        e.tenantId,
        `balance/${x.location_id}/${e.data.variantId}`,
        {
          locationId: x.location_id,
          variantId: e.data.variantId,
          qty: normQty(x.on_hand),
          minQty: normQty(x.min_qty),
          maxQty: x.max_qty === null ? null : normQty(x.max_qty),
        },
        e.data.variantId,
      ),
    ),
  );
  return fire.length;
}

export const LOW_STOCK_CONSUMER = "inventory.low-stock";

/** Structural twin of @wise-biz/events ConsumerDefinition. */
export function createLowStockConsumer(deps: JobDeps) {
  return {
    name: LOW_STOCK_CONSUMER,
    events: ["inventory.movement.recorded@v1"],
    maxAttempts: 5,
    handle: async (event: { readonly payload: unknown }, ctx: { readonly client: PoolClient }) => {
      await evaluateLowStock(ctx.client, deps, event.payload);
    },
  };
}

// --- Expiring batches (daily) ---

const EXPIRY_BATCH = 2_000;

/**
 * Announces every batch with stock that entered the horizon (expires within `horizonDays`, today included) and was not
 * announced yet. Claims rows with `expiry_alerted_on` inside the tenant transaction, so overlapping runs never send
 * twice. Returns how many batches were announced.
 */
export async function runExpiringBatches(deps: JobDeps, horizonDays = 7): Promise<number> {
  let total = 0;
  for (;;) {
    const due = await deps.pool.query<{ tenant_id: string; id: string }>(
      `select b.tenant_id, b.id from inventory.batches b
       where b.expiry_alerted_on is null and b.expires_on is not null
         and b.expires_on <= ($1::timestamptz at time zone 'UTC')::date + $2::int
         and exists (select 1 from inventory.stock_balances s
           where s.tenant_id = b.tenant_id and s.variant_id = b.variant_id and s.batch_id = b.id and s.qty > 0)
       order by b.tenant_id, b.id limit $3`,
      [deps.now(), horizonDays, EXPIRY_BATCH],
    );
    if (due.rows.length === 0) return total;
    const byTenant = new Map<string, string[]>();
    for (const r of due.rows)
      byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r.id]);
    for (const [tenantId, ids] of byTenant) {
      total += await withTenantTx(
        deps.pool,
        { tenantId, requestId: "job-expiring" },
        async (tx) => {
          const claimed = await tx.query<{
            id: string;
            variant_id: string;
            lot_code: string | null;
            expires_on: string;
          }>(
            `update inventory.batches set expiry_alerted_on = ($3::timestamptz at time zone 'UTC')::date
           where tenant_id = $1 and id = any($2::uuid[]) and expiry_alerted_on is null
           returning id, variant_id, lot_code, expires_on::text`,
            [tenantId, ids, deps.now()],
          );
          if (claimed.rows.length === 0) return 0;
          const stock = await tx.query<{ batch_id: string; location_id: string; qty: string }>(
            `select batch_id, location_id, qty::text from inventory.stock_balances
           where tenant_id = $1 and variant_id = any($2::uuid[]) and batch_id = any($3::uuid[]) and qty > 0
           order by batch_id, location_id`,
            [
              tenantId,
              [...new Set(claimed.rows.map((c) => c.variant_id))],
              claimed.rows.map((c) => c.id),
            ],
          );
          await appendOutbox(
            tx,
            claimed.rows.map((c) =>
              jobEvent(
                deps,
                BatchExpiringV1,
                tenantId,
                `batch/${c.id}`,
                {
                  batchId: c.id,
                  variantId: c.variant_id,
                  lotCode: c.lot_code,
                  expiresOn: c.expires_on,
                  stock: stock.rows
                    .filter((s) => s.batch_id === c.id)
                    .map((s) => ({ locationId: s.location_id, qty: normQty(s.qty) })),
                },
                c.variant_id,
              ),
            ),
          );
          return claimed.rows.length;
        },
      );
    }
    if (due.rows.length < EXPIRY_BATCH) return total;
  }
}

// --- Drift check (nightly) ---

const MAX_DRIFT_EVENTS = 100;

/**
 * Re-derives every balance of every tenant from the ledger in ONE statement per tenant (one snapshot, so concurrent
 * writes cannot fake a mismatch) and reports disagreements as inventory.drift.detected (capped per tenant). Balances
 * are never auto-corrected: drift means a bug or a manual write, and someone must look. Returns total mismatches.
 */
export async function runDriftCheck(deps: JobDeps): Promise<number> {
  // Loose index scan over the balances primary key: one probe per tenant, not a full scan.
  const tenants = await deps.pool.query<{ id: string }>(
    `with recursive t as (
       (select tenant_id as id from inventory.stock_balances order by tenant_id limit 1)
       union all
       select (select tenant_id from inventory.stock_balances where tenant_id > t.id order by tenant_id limit 1)
       from t where t.id is not null
     )
     select id from t where id is not null`,
  );
  let total = 0;
  for (const { id: tenantId } of tenants.rows) {
    total += await withTenantTx(deps.pool, { tenantId, requestId: "job-drift" }, async (tx) => {
      const r = await tx.query<{
        location_id: string;
        variant_id: string;
        batch_id: string;
        balance: string;
        ledger: string;
        n: string;
      }>(
        `with l as (
           select location_id, variant_id, coalesce(batch_id, '${NO_BATCH}'::uuid) as batch_id, sum(qty) as qty
           from inventory.stock_movements where tenant_id = $1 group by 1, 2, 3
         ), b as (
           select location_id, variant_id, batch_id, qty from inventory.stock_balances where tenant_id = $1
         ), d as (
           select coalesce(b.location_id, l.location_id) as location_id, coalesce(b.variant_id, l.variant_id) as variant_id,
             coalesce(b.batch_id, l.batch_id) as batch_id, coalesce(b.qty, 0) as balance, coalesce(l.qty, 0) as ledger
           from b full join l using (location_id, variant_id, batch_id)
           where coalesce(b.qty, 0) <> coalesce(l.qty, 0)
         )
         select location_id, variant_id, batch_id, balance::text, ledger::text, (select count(*) from d)::text as n
         from d order by variant_id, location_id, batch_id limit $2`,
        [tenantId, MAX_DRIFT_EVENTS],
      );
      const mismatches = Number(r.rows[0]?.n ?? 0);
      await tx.query(
        `insert into inventory.drift_checks (tenant_id, checked_at, mismatches) values ($1, $2, $3)
         on conflict (tenant_id) do update set checked_at = excluded.checked_at, mismatches = excluded.mismatches`,
        [tenantId, deps.now(), mismatches],
      );
      await appendOutbox(
        tx,
        r.rows.map((x) =>
          jobEvent(
            deps,
            DriftDetectedV1,
            tenantId,
            `balance/${x.location_id}/${x.variant_id}`,
            {
              locationId: x.location_id,
              variantId: x.variant_id,
              batchId: x.batch_id === NO_BATCH ? null : x.batch_id,
              balanceQty: fromQty4(toQty4(x.balance)),
              ledgerQty: fromQty4(toQty4(x.ledger)),
            },
            x.variant_id,
          ),
        ),
      );
      return mismatches;
    });
  }
  return total;
}
