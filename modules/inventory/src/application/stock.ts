import { lineValueMinor, toQty4 } from "../domain/qty.ts";
import { BatchReceivedV1, BatchUpdatedV1 } from "../events.ts";
import { recordMovements } from "../port.ts";

import { inventoryEvent, invalid, iso, notFound, one } from "./shared.ts";

import type { MovementReason } from "../port.ts";
import type { AdjustSchema, ReceiveSchema, UpdateBatchSchema } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

/** Tenancy owns locations; the composition root answers in the caller's tenant transaction (RLS applies). */
export type LocationExists = (
  tx: TxHandle,
  tenantId: string,
  locationId: string,
) => Promise<boolean>;

async function requireLocation(tx: TxHandle, tenantId: string, id: string, exists: LocationExists) {
  if (!(await exists(tx, tenantId, id))) invalid("locationId", "Unknown location.");
}

/** Variant facts from the catalog projection; unknown or archived variants are 422 on the line. */
async function facts(
  tx: TxHandle,
  tenantId: string,
  lines: readonly { variantId: string }[],
): Promise<Map<string, { tracksBatches: boolean }>> {
  const ids = [...new Set(lines.map((l) => l.variantId))];
  const r = await tx.query<{ variant_id: string; tracks_batches: boolean; archived: boolean }>(
    `select variant_id, tracks_batches, archived from inventory.variant_facts
     where tenant_id = $1 and variant_id = any($2::uuid[])`,
    [tenantId, ids],
  );
  const m = new Map(
    r.rows
      .filter((x) => !x.archived)
      .map((x) => [x.variant_id, { tracksBatches: x.tracks_batches }]),
  );
  lines.forEach((l, i) => {
    if (!m.has(l.variantId))
      invalid(`lines.${String(i)}.variantId`, "Unknown or archived variant.");
  });
  return m;
}

// --- Receive ---

export async function receiveCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: z.output<typeof ReceiveSchema>,
  locationExists: LocationExists,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  await requireLocation(tx, tenantId, input.locationId, locationExists);
  const f = await facts(tx, tenantId, input.lines);
  const id = input.id ?? ctx.ids.uuidv7();
  const receivedAt = input.receivedAt === undefined ? ctx.now : new Date(input.receivedAt);
  const lines = input.lines.map((l, i) => {
    const tracked = f.get(l.variantId)?.tracksBatches === true;
    const batchFields =
      l.lotCode !== undefined || l.expiresOn !== undefined || l.salePriceMinor !== undefined;
    if (!tracked && batchFields) {
      invalid(
        `lines.${String(i)}`,
        "This variant does not track batches: lot, expiry and batch price do not apply.",
      );
    }
    return { ...l, line: i, batchId: tracked ? ctx.ids.uuidv7() : null };
  });
  await tx.query(
    `insert into inventory.receipts (tenant_id, id, location_id, supplier_id, purchase_order_id, reference, currency,
       received_at, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      tenantId,
      id,
      input.locationId,
      input.supplierId ?? null,
      input.purchaseOrderId ?? null,
      input.reference ?? null,
      input.currency,
      receivedAt,
      ctx.userId,
      ctx.now,
    ],
  );
  const batches = lines.filter((l) => l.batchId !== null);
  if (batches.length > 0) {
    await tx.query(
      `insert into inventory.batches (tenant_id, id, variant_id, lot_code, expires_on, currency, unit_cost_minor,
         sale_price_minor, receipt_id, supplier_id, received_at, created_at)
       select $1, b.id, b.variant_id, b.lot_code, b.expires_on, $2, b.unit_cost_minor, b.sale_price_minor, $3, $4, $5, $6
       from jsonb_to_recordset($7::jsonb) as b(id uuid, variant_id uuid, lot_code text, expires_on date,
         unit_cost_minor bigint, sale_price_minor bigint)`,
      [
        tenantId,
        input.currency,
        id,
        input.supplierId ?? null,
        receivedAt,
        ctx.now,
        JSON.stringify(
          batches.map((b) => ({
            id: b.batchId,
            variant_id: b.variantId,
            lot_code: b.lotCode ?? null,
            expires_on: b.expiresOn ?? null,
            unit_cost_minor: b.unitCostMinor,
            sale_price_minor: b.salePriceMinor ?? null,
          })),
        ),
      ],
    );
  }
  await tx.query(
    `insert into inventory.receipt_lines (tenant_id, receipt_id, line, variant_id, batch_id, qty, unit_cost_minor)
     select $1, $2, l.line, l.variant_id, l.batch_id, l.qty, l.unit_cost_minor
     from jsonb_to_recordset($3::jsonb) as l(line int, variant_id uuid, batch_id uuid, qty numeric, unit_cost_minor bigint)`,
    [
      tenantId,
      id,
      JSON.stringify(
        lines.map((l) => ({
          line: l.line,
          variant_id: l.variantId,
          batch_id: l.batchId,
          qty: l.qty,
          unit_cost_minor: l.unitCostMinor,
        })),
      ),
    ],
  );
  const recorded = await recordMovements(
    tx,
    ctx,
    { type: "receipt", id, occurredAt: receivedAt },
    lines.map((l) => ({
      locationId: input.locationId,
      variantId: l.variantId,
      batchId: l.batchId,
      qty: l.qty,
      reason: "receive",
      sourceLine: l.line,
      unitCostMinor: l.unitCostMinor,
    })),
  );
  const body = {
    id,
    locationId: input.locationId,
    currency: input.currency,
    receivedAt: receivedAt.toISOString(),
    lines: lines.map((l) => ({
      line: l.line,
      variantId: l.variantId,
      batchId: l.batchId,
      qty: l.qty,
      unitCostMinor: l.unitCostMinor,
    })),
    balances: recorded.balances,
  };
  return {
    status: 201,
    body,
    audit: [
      {
        action: "inventory.stock.received",
        entity: "inventory.receipt",
        entityId: id,
        after: body,
      },
    ],
    events: [
      ...batches.map((b) =>
        inventoryEvent(
          BatchReceivedV1,
          ctx,
          `batch/${String(b.batchId)}`,
          {
            batchId: b.batchId,
            variantId: b.variantId,
            lotCode: b.lotCode ?? null,
            expiresOn: b.expiresOn ?? null,
            currency: input.currency,
            unitCostMinor: b.unitCostMinor,
            salePriceMinor: b.salePriceMinor ?? null,
            receivedAt: receivedAt.toISOString(),
          },
          b.variantId,
        ),
      ),
      ...recorded.events,
    ],
  };
}

// --- Adjust ---

const MOVEMENT_REASON: Readonly<Record<string, MovementReason>> = {
  count_correction: "count_variance",
  expiry: "expiry",
  writeoff: "writeoff",
};

/**
 * Unit cost per line: the batch's own cost, else the latest received cost of the variant at the location (one lateral
 * index probe per distinct variant), else 0.
 */
async function unitCosts(
  tx: TxHandle,
  tenantId: string,
  locationId: string,
  lines: readonly { variantId: string; batchId?: string | null | undefined }[],
): Promise<number[]> {
  const batchIds = [...new Set(lines.flatMap((l) => (l.batchId == null ? [] : [l.batchId])))];
  const variants = [...new Set(lines.filter((l) => l.batchId == null).map((l) => l.variantId))];
  const [b, v] = [
    batchIds.length === 0
      ? { rows: [] }
      : await tx.query<{ id: string; variant_id: string; unit_cost_minor: string }>(
          `select id, variant_id, unit_cost_minor from inventory.batches where tenant_id = $1 and id = any($2::uuid[])`,
          [tenantId, batchIds],
        ),
    variants.length === 0
      ? { rows: [] }
      : await tx.query<{ variant_id: string; unit_cost_minor: string }>(
          `select v.variant_id, m.unit_cost_minor from unnest($3::uuid[]) as v(variant_id)
           cross join lateral (
             select unit_cost_minor from inventory.stock_movements
             where tenant_id = $1 and variant_id = v.variant_id and location_id = $2 and reason = 'receive'
             order by occurred_at desc, id desc limit 1
           ) m`,
          [tenantId, locationId, variants],
        ),
  ];
  const batch = new Map(b.rows.map((x) => [x.id, x]));
  const latest = new Map(v.rows.map((x) => [x.variant_id, Number(x.unit_cost_minor)]));
  return lines.map((l, i) => {
    if (l.batchId == null) return latest.get(l.variantId) ?? 0;
    const row = batch.get(l.batchId);
    if (row?.variant_id !== l.variantId)
      return invalid(`lines.${String(i)}.batchId`, "Unknown batch for this variant.");
    return Number(row.unit_cost_minor);
  });
}

/**
 * Manual correction with a reason. The value (sum of |qty| x unit cost) is the ABAC resource amount, so a role limited
 * by `maxAmountMinor` gets 412 with the roles that may approve. Authorization happens inside the transaction, after
 * costs are known, and its failure rolls everything back.
 */
export async function adjustCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: z.output<typeof AdjustSchema>,
  deps: { locationExists: LocationExists; authorizeValue: (amountMinor: number) => void },
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  await requireLocation(tx, tenantId, input.locationId, deps.locationExists);
  const f = await facts(tx, tenantId, input.lines);
  input.lines.forEach((l, i) => {
    const tracked = f.get(l.variantId)?.tracksBatches === true;
    if (tracked && l.batchId == null)
      invalid(`lines.${String(i)}.batchId`, "This variant tracks batches: pick one.");
    if (!tracked && l.batchId != null)
      invalid(`lines.${String(i)}.batchId`, "This variant does not track batches.");
  });
  const costs = await unitCosts(tx, tenantId, input.locationId, input.lines);
  const value = input.lines.reduce(
    (a, l, i) => a + lineValueMinor(toQty4(l.qty), costs[i] ?? 0),
    0,
  );
  deps.authorizeValue(value);
  const id = input.id ?? ctx.ids.uuidv7();
  await tx.query(
    `insert into inventory.adjustments (tenant_id, id, location_id, reason, note, value_minor, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, id, input.locationId, input.reason, input.note ?? null, value, ctx.userId, ctx.now],
  );
  await tx.query(
    `insert into inventory.adjustment_lines (tenant_id, adjustment_id, line, variant_id, batch_id, qty, unit_cost_minor)
     select $1, $2, l.line, l.variant_id, l.batch_id, l.qty, l.unit_cost_minor
     from jsonb_to_recordset($3::jsonb) as l(line int, variant_id uuid, batch_id uuid, qty numeric, unit_cost_minor bigint)`,
    [
      tenantId,
      id,
      JSON.stringify(
        input.lines.map((l, i) => ({
          line: i,
          variant_id: l.variantId,
          batch_id: l.batchId ?? null,
          qty: l.qty,
          unit_cost_minor: costs[i],
        })),
      ),
    ],
  );
  const recorded = await recordMovements(
    tx,
    ctx,
    { type: "adjustment", id, occurredAt: ctx.now },
    input.lines.map((l, i) => ({
      locationId: input.locationId,
      variantId: l.variantId,
      batchId: l.batchId ?? null,
      qty: l.qty,
      reason: MOVEMENT_REASON[input.reason] ?? "adjust",
      sourceLine: i,
      unitCostMinor: costs[i] ?? null,
    })),
  );
  const body = {
    id,
    locationId: input.locationId,
    reason: input.reason,
    valueMinor: value,
    balances: recorded.balances,
  };
  return {
    status: 201,
    body,
    audit: [
      {
        action: "inventory.stock.adjusted",
        entity: "inventory.adjustment",
        entityId: id,
        after: { ...body, lines: input.lines, note: input.note ?? null },
      },
    ],
    events: recorded.events,
  };
}

// --- Batches ---

interface BatchRow {
  id: string;
  variant_id: string;
  lot_code: string | null;
  expires_on: string | null;
  currency: string;
  unit_cost_minor: string;
  sale_price_minor: string | null;
  received_at: Date;
}
const BATCH_COLS = `id, variant_id, lot_code, expires_on::text, currency, unit_cost_minor, sale_price_minor, received_at`;
export const toBatch = (r: BatchRow) => ({
  id: r.id,
  variantId: r.variant_id,
  lotCode: r.lot_code,
  expiresOn: r.expires_on,
  currency: r.currency,
  unitCostMinor: Number(r.unit_cost_minor),
  salePriceMinor: r.sale_price_minor === null ? null : Number(r.sale_price_minor),
  receivedAt: iso(r.received_at),
});

export async function updateBatchCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  input: z.output<typeof UpdateBatchSchema>,
): Promise<CommandResult> {
  const cur = await tx.query<BatchRow>(
    `select ${BATCH_COLS} from inventory.batches where tenant_id = $1 and id = $2 for update`,
    [ctx.tenant.tenantId, id],
  );
  const row = cur.rows[0];
  if (row === undefined) return notFound();
  const before = toBatch(row);
  const r = await tx.query<BatchRow>(
    `update inventory.batches set sale_price_minor = $3 where tenant_id = $1 and id = $2 returning ${BATCH_COLS}`,
    [ctx.tenant.tenantId, id, input.salePriceMinor],
  );
  const after = toBatch(one(r.rows));
  return {
    status: 200,
    body: after,
    audit: [
      { action: "inventory.batch.updated", entity: "inventory.batch", entityId: id, before, after },
    ],
    events: [
      inventoryEvent(
        BatchUpdatedV1,
        ctx,
        `batch/${id}`,
        {
          batchId: id,
          variantId: after.variantId,
          salePriceMinor: after.salePriceMinor,
        },
        after.variantId,
      ),
    ],
  };
}

export async function listBatches(
  tx: TxHandle,
  tenantId: string,
  q: { variantId: string; expiringBefore?: string | undefined },
) {
  const r = await tx.query<BatchRow>(
    `select ${BATCH_COLS} from inventory.batches
     where tenant_id = $1 and variant_id = $2 ${q.expiringBefore === undefined ? "" : "and expires_on < $3::date"}
     order by expires_on nulls last, id limit 500`,
    q.expiringBefore === undefined
      ? [tenantId, q.variantId]
      : [tenantId, q.variantId, q.expiringBefore],
  );
  return r.rows.map(toBatch);
}

/** Sale prices of batches that have their own (pricing quote, P1-04c). One indexed query. */
export async function batchSalePrices(
  tx: TxHandle,
  tenantId: string,
  batchIds: readonly string[],
): Promise<
  Map<string, { variantId: string; salePriceMinor: number | null; expiresOn: string | null }>
> {
  if (batchIds.length === 0) return new Map();
  const r = await tx.query<{
    id: string;
    variant_id: string;
    sale_price_minor: string | null;
    expires_on: string | null;
  }>(
    `select id, variant_id, sale_price_minor, expires_on::text from inventory.batches
     where tenant_id = $1 and id = any($2::uuid[])`,
    [tenantId, [...new Set(batchIds)]],
  );
  return new Map(
    r.rows.map((x) => [
      x.id,
      {
        variantId: x.variant_id,
        salePriceMinor: x.sale_price_minor === null ? null : Number(x.sale_price_minor),
        expiresOn: x.expires_on,
      },
    ]),
  );
}
