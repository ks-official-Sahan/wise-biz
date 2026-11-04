import { fromQty4, NO_BATCH, normQty, toQty4 } from "../domain/qty.ts";

import type { BalancesQuerySchema, MovementsQuerySchema, SetThresholdsSchema } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

/**
 * Balances by location or by variant (one of them is required), summed over batches unless `byBatch`. Keyset over the
 * other key. Served by the primary key (location first) or stock_balances_tenant_variant_idx (variant first).
 */
export async function listBalances(
  tx: TxHandle,
  tenantId: string,
  q: z.output<typeof BalancesQuerySchema>,
) {
  const limit = q.limit ?? 200;
  const params: unknown[] = [tenantId, limit + 1];
  const where = ["s.tenant_id = $1"];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${String(params.length)}`));
  };
  if (q.locationId !== undefined) add("s.location_id = ?", q.locationId);
  if (q.variantId !== undefined) add("s.variant_id = ?", q.variantId);
  // Keyset: (variant, location, batch) when browsing a location, (location, variant, batch) for a variant.
  const keyCols =
    q.locationId !== undefined
      ? ["s.variant_id", "s.location_id"]
      : ["s.location_id", "s.variant_id"];
  const byBatch = q.byBatch === true || q.expiringBefore !== undefined;
  if (q.after !== undefined) {
    const [a, b, c = NO_BATCH] = q.after.split("|");
    const cols = byBatch ? [...keyCols, "s.batch_id"] : keyCols;
    const vals = (byBatch ? [a, b, c] : [a, b]).map((v) => {
      params.push(v);
      return `$${String(params.length)}::uuid`;
    });
    where.push(`(${cols.join(", ")}) > (${vals.join(", ")})`);
  }
  if (q.expiringBefore !== undefined) add("b.expires_on < ?::date", q.expiringBefore);
  const order = `${keyCols.join(", ")}, s.batch_id`;
  const sql = byBatch
    ? `select s.location_id, s.variant_id, s.batch_id, s.qty::text, s.reserved::text,
         b.lot_code, b.expires_on::text, b.sale_price_minor
       from inventory.stock_balances s
       left join inventory.batches b on b.tenant_id = s.tenant_id and b.id = s.batch_id
       where ${where.join(" and ")} order by ${order} limit $2`
    : `select s.location_id, s.variant_id, '${NO_BATCH}'::uuid as batch_id, sum(s.qty)::text as qty,
         sum(s.reserved)::text as reserved, null as lot_code, null as expires_on, null as sale_price_minor
       from inventory.stock_balances s
       where ${where.join(" and ")}
       group by s.location_id, s.variant_id order by ${keyCols.join(", ")} limit $2`;
  const r = await tx.query<{
    location_id: string;
    variant_id: string;
    batch_id: string;
    qty: string;
    reserved: string;
    lot_code: string | null;
    expires_on: string | null;
    sale_price_minor: string | null;
  }>(sql, params);
  const rows = r.rows.slice(0, limit);
  const last = rows.at(-1);
  const keyOf = (x: (typeof rows)[number]) =>
    q.locationId !== undefined
      ? `${x.variant_id}|${x.location_id}|${x.batch_id}`
      : `${x.location_id}|${x.variant_id}|${x.batch_id}`;
  return {
    items: rows.map((x) => {
      const qty = normQty(x.qty);
      const reserved = normQty(x.reserved);
      return {
        locationId: x.location_id,
        variantId: x.variant_id,
        batchId: x.batch_id === NO_BATCH ? null : x.batch_id,
        qty,
        reserved,
        available: fromQty4(toQty4(qty) - toQty4(reserved)),
        ...(byBatch
          ? {
              lotCode: x.lot_code,
              expiresOn: x.expires_on,
              salePriceMinor: x.sale_price_minor === null ? null : Number(x.sale_price_minor),
            }
          : {}),
      };
    }),
    nextCursor: r.rows.length > limit && last !== undefined ? keyOf(last) : null,
  };
}

/** One SKU's ledger, newest first; keyset on (occurred_at, id). */
export async function listMovements(
  tx: TxHandle,
  tenantId: string,
  q: z.output<typeof MovementsQuerySchema>,
) {
  const limit = q.limit ?? 100;
  const params: unknown[] = [tenantId, q.variantId, limit + 1];
  let extra = "";
  if (q.locationId !== undefined) {
    params.push(q.locationId);
    extra += ` and location_id = $${String(params.length)}`;
  }
  if (q.before !== undefined) {
    const [at, id] = q.before.split("|");
    params.push(at, id);
    extra += ` and (occurred_at, id) < ($${String(params.length - 1)}::timestamptz, $${String(params.length)}::uuid)`;
  }
  const r = await tx.query<{
    id: string;
    location_id: string;
    batch_id: string | null;
    qty: string;
    reason: string;
    source_type: string;
    source_id: string;
    unit_cost_minor: string | null;
    occurred_at: Date;
  }>(
    `select id, location_id, batch_id, qty::text, reason, source_type, source_id, unit_cost_minor, occurred_at
     from inventory.stock_movements where tenant_id = $1 and variant_id = $2${extra}
     order by occurred_at desc, id desc limit $3`,
    params,
  );
  const rows = r.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map((x) => ({
      id: x.id,
      locationId: x.location_id,
      batchId: x.batch_id,
      qty: normQty(x.qty),
      reason: x.reason,
      sourceType: x.source_type,
      sourceId: x.source_id,
      unitCostMinor: x.unit_cost_minor === null ? null : Number(x.unit_cost_minor),
      occurredAt: x.occurred_at.toISOString(),
    })),
    nextCursor:
      r.rows.length > limit && last !== undefined
        ? `${last.occurred_at.toISOString()}|${last.id}`
        : null,
  };
}

// --- Thresholds ---

export async function listThresholds(tx: TxHandle, tenantId: string, locationId: string) {
  const r = await tx.query<{
    variant_id: string;
    min_qty: string;
    max_qty: string | null;
    low_since: Date | null;
  }>(
    `select variant_id, min_qty::text, max_qty::text, low_since from inventory.stock_thresholds
     where tenant_id = $1 and location_id = $2 order by variant_id`,
    [tenantId, locationId],
  );
  return r.rows.map((x) => ({
    locationId,
    variantId: x.variant_id,
    minQty: normQty(x.min_qty),
    maxQty: x.max_qty === null ? null : normQty(x.max_qty),
    lowSince: x.low_since?.toISOString() ?? null,
  }));
}

/** Upserts (or removes, minQty null) up to 1000 thresholds of one location in two statements. */
export async function setThresholdsCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: z.output<typeof SetThresholdsSchema>,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const set = input.items.filter((t) => t.minQty !== null);
  const removed = input.items.filter((t) => t.minQty === null).map((t) => t.variantId);
  if (set.length > 0) {
    await tx.query(
      `insert into inventory.stock_thresholds (tenant_id, location_id, variant_id, min_qty, max_qty, updated_at)
       select $1, $2, t.variant_id, t.min_qty, t.max_qty, $4
       from jsonb_to_recordset($3::jsonb) as t(variant_id uuid, min_qty numeric, max_qty numeric)
       order by t.variant_id
       on conflict (tenant_id, location_id, variant_id) do update
         set min_qty = excluded.min_qty, max_qty = excluded.max_qty, updated_at = excluded.updated_at`,
      [
        tenantId,
        input.locationId,
        JSON.stringify(
          set.map((t) => ({
            variant_id: t.variantId,
            min_qty: t.minQty,
            max_qty: t.maxQty ?? null,
          })),
        ),
        ctx.now,
      ],
    );
  }
  if (removed.length > 0) {
    await tx.query(
      "delete from inventory.stock_thresholds where tenant_id = $1 and location_id = $2 and variant_id = any($3::uuid[])",
      [tenantId, input.locationId, removed],
    );
  }
  const body = { locationId: input.locationId, set: set.length, removed: removed.length };
  return {
    status: 200,
    body,
    audit: [
      {
        action: "inventory.thresholds.set",
        entity: "inventory.location",
        entityId: input.locationId,
        after: { ...body, items: input.items },
      },
    ],
    // Thresholds only feed the low-stock evaluator; devices do not need them.
    noEvents: true,
  };
}
