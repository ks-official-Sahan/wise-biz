import {
  applyReceipt,
  assertTransition,
  RECEIVING,
  shortQty,
  totalMinor,
  type PoStatus,
} from "../domain/po.ts";
import { normQty } from "../domain/qty.ts";
import { PurchaseOrderClosedV1, PurchaseOrderReceivedV1, PurchaseOrderSentV1 } from "../events.ts";

import {
  conflict,
  decodeCursor,
  invalid,
  iso,
  notFound,
  one,
  page,
  procurementEvent,
  requireVersion,
} from "./shared.ts";

import type { ProcurementDeps, RefsPort } from "../port.ts";
import type { CreatePoSchema, PoListQuery, ReceiveSchema, UpdatePoSchema } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

/** Over-receipt tolerance when a business has no settings row: 5 %. */
export const DEFAULT_OVER_RECEIPT_BPS = 500;

interface PoRow {
  id: string;
  po_no: string;
  supplier_id: string;
  branch_id: string;
  location_id: string;
  currency: string;
  status: PoStatus;
  expected_on: string | null;
  notes: string;
  total_minor: string;
  version: number;
  sent_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
// bigint columns come back as strings: po_no and total_minor are cast to text, dates to text (no timezone shift).
const PO_COLS = `id, po_no::text as po_no, supplier_id, branch_id, location_id, currency, status,
  expected_on::text as expected_on, notes, total_minor::text as total_minor, version, sent_at, closed_at,
  cancelled_at, created_at, updated_at`;

interface LineRow {
  purchase_order_id: string;
  line: number;
  variant_id: string;
  ordered_qty: string;
  received_qty: string;
  short_qty: string;
  unit_cost_minor: string;
  line_total_minor: string;
}
const LINE_COLS = `purchase_order_id, line, variant_id, ordered_qty::text as ordered_qty,
  received_qty::text as received_qty, short_qty::text as short_qty, unit_cost_minor::text as unit_cost_minor,
  line_total_minor::text as line_total_minor`;

export interface PoLine {
  line: number;
  variantId: string;
  orderedQty: string;
  receivedQty: string;
  shortQty: string;
  unitCostMinor: number;
  lineTotalMinor: number;
}

export interface PurchaseOrder {
  id: string;
  poNo: number;
  supplierId: string;
  branchId: string;
  locationId: string;
  currency: string;
  status: PoStatus;
  expectedOn: string | null;
  notes: string;
  totalMinor: number;
  version: number;
  sentAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: PoLine[];
}

const toLine = (r: LineRow): PoLine => ({
  line: r.line,
  variantId: r.variant_id,
  orderedQty: normQty(r.ordered_qty),
  receivedQty: normQty(r.received_qty),
  shortQty: normQty(r.short_qty),
  unitCostMinor: Number(r.unit_cost_minor),
  lineTotalMinor: Number(r.line_total_minor),
});

const toPo = (r: PoRow, lines: readonly LineRow[]): PurchaseOrder => ({
  id: r.id,
  poNo: Number(r.po_no),
  supplierId: r.supplier_id,
  branchId: r.branch_id,
  locationId: r.location_id,
  currency: r.currency,
  status: r.status,
  expectedOn: r.expected_on,
  notes: r.notes,
  totalMinor: Number(r.total_minor),
  version: r.version,
  sentAt: iso(r.sent_at),
  closedAt: iso(r.closed_at),
  cancelledAt: iso(r.cancelled_at),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  lines: lines.map(toLine),
});

/** Lines for many POs in one query (no N+1), grouped by PO id. */
async function linesFor(
  tx: TxHandle,
  tenantId: string,
  poIds: readonly string[],
): Promise<Map<string, LineRow[]>> {
  const out = new Map<string, LineRow[]>();
  if (poIds.length === 0) return out;
  const r = await tx.query<LineRow>(
    `select ${LINE_COLS} from procurement.po_lines
      where tenant_id = $1 and purchase_order_id = any($2::uuid[])
      order by purchase_order_id, line`,
    [tenantId, [...poIds]],
  );
  for (const row of r.rows) {
    const list = out.get(row.purchase_order_id) ?? [];
    list.push(row);
    out.set(row.purchase_order_id, list);
  }
  return out;
}

async function loadPo(tx: TxHandle, tenantId: string, id: string, lock: boolean) {
  const r = await tx.query<PoRow>(
    `select ${PO_COLS} from procurement.purchase_orders where tenant_id = $1 and id = $2${lock ? " for update" : ""}`,
    [tenantId, id],
  );
  const po = r.rows[0];
  if (po === undefined) return notFound();
  const lines = await linesFor(tx, tenantId, [id]);
  return { po, lines: lines.get(id) ?? [] };
}

export async function getPo(tx: TxHandle, tenantId: string, id: string): Promise<PurchaseOrder> {
  const { po, lines } = await loadPo(tx, tenantId, id, false);
  return toPo(po, lines);
}

export async function listPos(tx: TxHandle, tenantId: string, q: z.infer<typeof PoListQuery>) {
  const params: unknown[] = [tenantId];
  const where = ["tenant_id = $1"];
  if (q.status !== undefined) {
    params.push(q.status);
    where.push(`status = $${String(params.length)}`);
  }
  if (q.after !== undefined) {
    params.push(decodeCursor(q.after));
    where.push(`id < $${String(params.length)}`);
  }
  params.push(q.limit + 1);
  // Newest first: UUIDv7 ids sort by creation time, so a backwards keyset walks the newest pages.
  const r = await tx.query<PoRow>(
    `select ${PO_COLS} from procurement.purchase_orders where ${where.join(" and ")}
      order by id desc limit $${String(params.length)}`,
    params,
  );
  const items = page(r.rows, q.limit);
  const lines = await linesFor(
    tx,
    tenantId,
    items.items.map((p) => p.id),
  );
  return {
    items: items.items.map((p) => toPo(p, lines.get(p.id) ?? [])),
    nextCursor: items.nextCursor,
  };
}

type CreateInput = z.infer<typeof CreatePoSchema>;
type UpdateInput = z.infer<typeof UpdatePoSchema>;
type LineIn = CreateInput["lines"][number];

/** Every variant on the lines must exist and be active (one query); the index is the variant_facts primary key. */
async function requireVariants(
  tx: TxHandle,
  tenantId: string,
  lines: readonly LineIn[],
  refs: RefsPort,
): Promise<void> {
  const known = await refs.variantsExist(tx, tenantId, [...new Set(lines.map((l) => l.variantId))]);
  lines.forEach((l, n) => {
    if (!known.has(l.variantId))
      invalid(`lines.${String(n)}.variantId`, "Unknown or archived variant.");
  });
}

async function supplierCurrency(
  tx: TxHandle,
  tenantId: string,
  supplierId: string,
): Promise<string> {
  const r = await tx.query<{ currency: string; archived_at: Date | null }>(
    "select currency, archived_at from procurement.suppliers where tenant_id = $1 and id = $2",
    [tenantId, supplierId],
  );
  const s = r.rows[0];
  if (s === undefined) invalid("supplierId", "Unknown supplier.");
  if (s.archived_at !== null) invalid("supplierId", "Archived supplier.");
  return s.currency;
}

/** Replace a draft's lines in one statement each (delete, then insert from one JSON array). */
async function writeLines(tx: TxHandle, tenantId: string, poId: string, lines: readonly LineIn[]) {
  await tx.query(
    "delete from procurement.po_lines where tenant_id = $1 and purchase_order_id = $2",
    [tenantId, poId],
  );
  await tx.query(
    `insert into procurement.po_lines (tenant_id, purchase_order_id, line, variant_id, ordered_qty, unit_cost_minor)
     select $1, $2, x.line, x.variant_id, x.ordered_qty::numeric, x.unit_cost_minor
       from jsonb_to_recordset($3::jsonb) as x(line int, variant_id uuid, ordered_qty text, unit_cost_minor bigint)`,
    [
      tenantId,
      poId,
      JSON.stringify(
        lines.map((l, i) => ({
          line: i + 1,
          variant_id: l.variantId,
          ordered_qty: l.orderedQty,
          unit_cost_minor: l.unitCostMinor,
        })),
      ),
    ],
  );
}

const draftTotal = (lines: readonly LineIn[], currency: string) =>
  totalMinor(
    lines.map((l) => ({ qty: l.orderedQty, unitCostMinor: l.unitCostMinor })),
    currency,
  );

export async function createPoCommand(
  tx: TxHandle,
  ctx: CommandContext,
  b: CreateInput,
  refs: RefsPort,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const currency = await supplierCurrency(tx, tenantId, b.supplierId);
  if (!(await refs.branchExists(tx, tenantId, b.branchId))) invalid("branchId", "Unknown branch.");
  if (!(await refs.locationExists(tx, tenantId, b.locationId)))
    invalid("locationId", "Unknown location.");
  await requireVariants(tx, tenantId, b.lines, refs);
  const seq = await tx.query<{ last_no: string }>(
    `insert into procurement.po_sequences (tenant_id, last_no) values ($1, 1)
     on conflict (tenant_id) do update set last_no = procurement.po_sequences.last_no + 1
     returning last_no::text as last_no`,
    [tenantId],
  );
  const id = ctx.ids.uuidv7();
  await tx.query(
    `insert into procurement.purchase_orders (tenant_id, id, po_no, supplier_id, branch_id, location_id, currency,
       status, expected_on, notes, total_minor, version, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, 1, $11, $12, $12)
     returning ${PO_COLS}`,
    [
      tenantId,
      id,
      Number(one(seq.rows).last_no),
      b.supplierId,
      b.branchId,
      b.locationId,
      currency,
      b.expectedOn,
      b.notes,
      draftTotal(b.lines, currency),
      ctx.userId,
      ctx.now,
    ],
  );
  await writeLines(tx, tenantId, id, b.lines);
  const { po, lines } = await loadPo(tx, tenantId, id, false);
  const after = toPo(po, lines);
  return {
    status: 201,
    body: after,
    audit: [
      {
        action: "procurement.po.created",
        entity: "procurement.purchase_order",
        entityId: id,
        after,
      },
    ],
    noEvents: true,
  };
}

export async function updateDraftCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: UpdateInput,
  refs: RefsPort,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { po, lines: beforeLines } = await loadPo(tx, tenantId, id, true);
  const before = toPo(po, beforeLines);
  requireVersion(po.version, b.version);
  if (po.status !== "draft") throw conflict("Only a draft purchase order can be edited.");
  await requireVariants(tx, tenantId, b.lines, refs);
  await writeLines(tx, tenantId, id, b.lines);
  await tx.query(
    `update procurement.purchase_orders
        set expected_on = $3, notes = $4, total_minor = $5, version = version + 1, updated_at = $6
      where tenant_id = $1 and id = $2`,
    [tenantId, id, b.expectedOn, b.notes, draftTotal(b.lines, po.currency), ctx.now],
  );
  const reloaded = await loadPo(tx, tenantId, id, false);
  const after = toPo(reloaded.po, reloaded.lines);
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.po.updated",
        entity: "procurement.purchase_order",
        entityId: id,
        before,
        after,
      },
    ],
    noEvents: true,
  };
}

export async function sendPoCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  version: number,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { po, lines } = await loadPo(tx, tenantId, id, true);
  requireVersion(po.version, version);
  assertTransition(po.status, "sent");
  await tx.query(
    `update procurement.purchase_orders set status = 'sent', sent_at = $3, version = version + 1, updated_at = $3
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const after = toPo({ ...po, status: "sent", sent_at: ctx.now, version: po.version + 1 }, lines);
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.po.sent",
        entity: "procurement.purchase_order",
        entityId: id,
        after: { status: "sent", version: after.version },
      },
    ],
    events: [
      procurementEvent(PurchaseOrderSentV1, ctx, `purchase-order/${id}`, {
        purchaseOrderId: id,
        poNo: after.poNo,
        supplierId: after.supplierId,
        branchId: after.branchId,
        locationId: after.locationId,
        currency: after.currency,
        totalMinor: after.totalMinor,
        expectedOn: after.expectedOn,
        lines: after.lines.map((l) => ({
          line: l.line,
          variantId: l.variantId,
          orderedQty: l.orderedQty,
          unitCostMinor: l.unitCostMinor,
          lineTotalMinor: l.lineTotalMinor,
        })),
      }),
    ],
  };
}

export async function cancelPoCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  version: number,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { po, lines } = await loadPo(tx, tenantId, id, true);
  requireVersion(po.version, version);
  assertTransition(po.status, "cancelled");
  await tx.query(
    `update procurement.purchase_orders set status = 'cancelled', cancelled_at = $3, version = version + 1, updated_at = $3
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const after = toPo(
    { ...po, status: "cancelled", cancelled_at: ctx.now, version: po.version + 1 },
    lines,
  );
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.po.cancelled",
        entity: "procurement.purchase_order",
        entityId: id,
        before: { status: po.status },
        after: { status: "cancelled" },
      },
    ],
    noEvents: true,
  };
}

export async function closePoCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  version: number,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { po, lines } = await loadPo(tx, tenantId, id, true);
  requireVersion(po.version, version);
  assertTransition(po.status, "closed");
  const shorts = lines.map((l) => ({
    line: l.line,
    short: shortQty(normQty(l.ordered_qty), normQty(l.received_qty)),
  }));
  await tx.query(
    `update procurement.po_lines l set short_qty = x.short_qty::numeric
       from jsonb_to_recordset($3::jsonb) as x(line int, short_qty text)
      where l.tenant_id = $1 and l.purchase_order_id = $2 and l.line = x.line`,
    [tenantId, id, JSON.stringify(shorts.map((s) => ({ line: s.line, short_qty: s.short })))],
  );
  await tx.query(
    `update procurement.purchase_orders set status = 'closed', closed_at = $3, version = version + 1, updated_at = $3
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const reloaded = await loadPo(tx, tenantId, id, false);
  const after = toPo(reloaded.po, reloaded.lines);
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.po.closed",
        entity: "procurement.purchase_order",
        entityId: id,
        before: { status: po.status },
        after: { status: "closed", shortLines: shorts.filter((s) => s.short !== "0").length },
      },
    ],
    events: [
      procurementEvent(PurchaseOrderClosedV1, ctx, `purchase-order/${id}`, {
        purchaseOrderId: id,
        poNo: after.poNo,
        supplierId: after.supplierId,
        locationId: after.locationId,
        totalMinor: after.totalMinor,
        lines: after.lines.map((l) => ({
          line: l.line,
          variantId: l.variantId,
          orderedQty: l.orderedQty,
          receivedQty: l.receivedQty,
          shortQty: shortQty(l.orderedQty, l.receivedQty),
        })),
      }),
    ],
  };
}

/**
 * Receive against the PO: lock the PO (two receipts on one line serialise here), check the lines and the tolerance,
 * write the receipt, bump the line projections and the status, then post the stock receipt through the inventory
 * port in the same transaction. Stock is only ever added, at the PO's location, at each line's unit cost.
 */
export async function receivePoCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: z.infer<typeof ReceiveSchema>,
  deps: ProcurementDeps,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { po, lines } = await loadPo(tx, tenantId, id, true);
  if (!RECEIVING.includes(po.status)) {
    throw conflict(`A ${po.status} purchase order cannot receive stock.`);
  }
  const tol = await tx.query<{ over_receipt_bps: number }>(
    "select over_receipt_bps from procurement.settings where tenant_id = $1",
    [tenantId],
  );
  const bps = tol.rows[0]?.over_receipt_bps ?? DEFAULT_OVER_RECEIPT_BPS;
  const byLine = new Map(lines.map((l) => [l.line, l]));
  const plan = applyReceipt(
    lines.map((l) => ({
      line: l.line,
      orderedQty: normQty(l.ordered_qty),
      receivedQty: normQty(l.received_qty),
      unitCostMinor: Number(l.unit_cost_minor),
    })),
    b.lines.map((l) => ({ line: l.line, qty: l.qty })),
    bps,
  );
  // RECEIVING states only move to themselves or to received/partially_received, so this never throws in practice.
  assertTransition(po.status, plan.status);

  const receiptId = ctx.ids.uuidv7();
  const incoming = b.lines.map((l) => {
    const src = byLine.get(l.line);
    // applyReceipt already refused unknown lines; this keeps the type honest.
    if (src === undefined) return notFound();
    return {
      line: l.line,
      variantId: src.variant_id,
      qty: normQty(l.qty),
      unitCostMinor: Number(src.unit_cost_minor),
    };
  });
  await tx.query(
    `insert into procurement.po_receipts (tenant_id, id, purchase_order_id, reference, received_at, received_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $5)`,
    [tenantId, receiptId, id, b.reference, ctx.now, ctx.userId],
  );
  await tx.query(
    `insert into procurement.po_receipt_lines (tenant_id, receipt_id, po_line, variant_id, qty, unit_cost_minor)
     select $1, $2, x.po_line, x.variant_id, x.qty::numeric, x.unit_cost_minor
       from jsonb_to_recordset($3::jsonb) as x(po_line int, variant_id uuid, qty text, unit_cost_minor bigint)`,
    [
      tenantId,
      receiptId,
      JSON.stringify(
        incoming.map((l) => ({
          po_line: l.line,
          variant_id: l.variantId,
          qty: l.qty,
          unit_cost_minor: l.unitCostMinor,
        })),
      ),
    ],
  );
  await tx.query(
    `update procurement.po_lines l set received_qty = x.received_qty::numeric
       from jsonb_to_recordset($3::jsonb) as x(line int, received_qty text)
      where l.tenant_id = $1 and l.purchase_order_id = $2 and l.line = x.line`,
    [
      tenantId,
      id,
      JSON.stringify(
        [...plan.received].map(([line, received]) => ({ line, received_qty: received })),
      ),
    ],
  );
  await tx.query(
    `update procurement.purchase_orders set status = $3, version = version + 1, updated_at = $4
      where tenant_id = $1 and id = $2`,
    [tenantId, id, plan.status, ctx.now],
  );
  const stock = await deps.stock.recordMovements(
    tx,
    ctx,
    { type: "purchase_order_receipt", id: receiptId, occurredAt: ctx.now },
    incoming.map((l) => ({
      locationId: po.location_id,
      variantId: l.variantId,
      qty: l.qty,
      reason: "receive" as const,
      sourceLine: l.line,
      unitCostMinor: l.unitCostMinor,
    })),
  );
  const reloaded = await loadPo(tx, tenantId, id, false);
  const after = toPo(reloaded.po, reloaded.lines);
  const receipt = {
    id: receiptId,
    reference: b.reference,
    receivedAt: ctx.now.toISOString(),
    lines: incoming.map((l) => ({
      line: l.line,
      variantId: l.variantId,
      qty: l.qty,
      unitCostMinor: l.unitCostMinor,
    })),
  };
  return {
    status: 201,
    body: { receipt, purchaseOrder: after },
    audit: [
      {
        action: "procurement.po.received",
        entity: "procurement.po_receipt",
        entityId: receiptId,
        after: { purchaseOrderId: id, status: plan.status, lines: receipt.lines },
      },
    ],
    events: [
      procurementEvent(PurchaseOrderReceivedV1, ctx, `purchase-order/${id}`, {
        purchaseOrderId: id,
        poNo: after.poNo,
        receiptId,
        reference: b.reference,
        locationId: po.location_id,
        status: plan.status,
        receivedAt: receipt.receivedAt,
        lines: incoming.map((l) => {
          const now = after.lines.find((x) => x.line === l.line);
          return {
            line: l.line,
            variantId: l.variantId,
            qty: l.qty,
            unitCostMinor: l.unitCostMinor,
            orderedQty: now?.orderedQty ?? "0",
            receivedQty: now?.receivedQty ?? "0",
          };
        }),
      }),
      ...stock.events,
    ],
  };
}
