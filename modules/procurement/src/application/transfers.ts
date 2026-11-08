import { lineTotalMinor, maxReceivable } from "../domain/po.ts";
import { fromQty4, normQty, toQty4 } from "../domain/qty.ts";
import {
  assertDistinctLocations,
  assertTransferTransition,
  receivedSplit,
  varianceQty,
  type TransferStatus,
} from "../domain/transfer.ts";
import { TransferClosedV1, TransferDispatchedV1, TransferReceivedV1 } from "../events.ts";

import { DEFAULT_OVER_RECEIPT_BPS } from "./orders.ts";
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

import type { ProcurementDeps, StockMovement } from "../port.ts";
import type {
  CreateTransferSchema,
  DispatchTransferSchema,
  ReceiveTransferSchema,
  TransferListQuery,
} from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

/** A dispatched line may draw on this many batches at most; the ledger source line encodes the batch index. */
const MAX_DISPATCH_BATCHES = 499;
/** A receive writes three movements per batch, so its bound is smaller. */
const MAX_RECEIVE_BATCHES = 332;

interface TransferRow {
  id: string;
  transfer_no: string;
  from_location_id: string;
  to_location_id: string;
  in_transit_location_id: string;
  status: TransferStatus;
  notes: string;
  currency: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  dispatched_at: Date | null;
  received_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
}
const TRANSFER_COLS = `id, transfer_no::text as transfer_no, from_location_id, to_location_id, in_transit_location_id,
  status, notes, currency, version, created_at, updated_at, dispatched_at, received_at, closed_at, cancelled_at`;

interface TransferLineRow {
  transfer_id: string;
  line: number;
  variant_id: string;
  requested_qty: string;
  dispatched_qty: string;
  received_qty: string;
  variance_qty: string;
  value_minor: string;
}
const TLINE_COLS = `transfer_id, line, variant_id, requested_qty::text as requested_qty,
  dispatched_qty::text as dispatched_qty, received_qty::text as received_qty,
  variance_qty::text as variance_qty, value_minor::text as value_minor`;

export interface TransferLine {
  line: number;
  variantId: string;
  requestedQty: string;
  dispatchedQty: string;
  receivedQty: string;
  varianceQty: string;
  valueMinor: number;
}

export interface Transfer {
  id: string;
  transferNo: number;
  fromLocationId: string;
  toLocationId: string;
  status: TransferStatus;
  notes: string;
  currency: string | null;
  /** On the road now: dispatched and not yet received. Zero before dispatch and after receive. */
  inTransitQty: string;
  inTransitValueMinor: number;
  version: number;
  dispatchedAt: string | null;
  receivedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: TransferLine[];
}

const toLine = (r: TransferLineRow): TransferLine => ({
  line: r.line,
  variantId: r.variant_id,
  requestedQty: normQty(r.requested_qty),
  dispatchedQty: normQty(r.dispatched_qty),
  receivedQty: normQty(r.received_qty),
  varianceQty: normQty(r.variance_qty),
  valueMinor: Number(r.value_minor),
});

const toTransfer = (r: TransferRow, lines: readonly TransferLineRow[]): Transfer => {
  const onRoad = r.status === "dispatched";
  // Exact integer sums: quantities are ten-thousandths and values are minor units, so nothing rounds here.
  const qty = onRoad ? lines.reduce((a, l) => a + toQty4(l.dispatched_qty), 0n) : 0n;
  const value = onRoad ? lines.reduce((a, l) => a + BigInt(l.value_minor), 0n) : 0n;
  return {
    id: r.id,
    transferNo: Number(r.transfer_no),
    fromLocationId: r.from_location_id,
    toLocationId: r.to_location_id,
    status: r.status,
    notes: r.notes,
    currency: r.currency,
    inTransitQty: fromQty4(qty),
    inTransitValueMinor: Number(value),
    version: r.version,
    dispatchedAt: iso(r.dispatched_at),
    receivedAt: iso(r.received_at),
    closedAt: iso(r.closed_at),
    cancelledAt: iso(r.cancelled_at),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    lines: lines.map(toLine),
  };
};

/** Lines for many transfers in one query (no N+1), grouped by transfer id. */
async function linesFor(
  tx: TxHandle,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, TransferLineRow[]>> {
  const out = new Map<string, TransferLineRow[]>();
  if (ids.length === 0) return out;
  const r = await tx.query<TransferLineRow>(
    `select ${TLINE_COLS} from procurement.transfer_lines
      where tenant_id = $1 and transfer_id = any($2::uuid[]) order by transfer_id, line`,
    [tenantId, [...ids]],
  );
  for (const row of r.rows) {
    const list = out.get(row.transfer_id) ?? [];
    list.push(row);
    out.set(row.transfer_id, list);
  }
  return out;
}

async function loadTransfer(tx: TxHandle, tenantId: string, id: string, lock: boolean) {
  const r = await tx.query<TransferRow>(
    `select ${TRANSFER_COLS} from procurement.transfers where tenant_id = $1 and id = $2${lock ? " for update" : ""}`,
    [tenantId, id],
  );
  const row = r.rows[0];
  if (row === undefined) return notFound();
  const lines = await linesFor(tx, tenantId, [id]);
  return { row, lines: lines.get(id) ?? [] };
}

export async function getTransfer(tx: TxHandle, tenantId: string, id: string): Promise<Transfer> {
  const { row, lines } = await loadTransfer(tx, tenantId, id, false);
  return toTransfer(row, lines);
}

/** Newest first; the status filter rides the (tenant, status, id) index. */
export async function listTransfers(
  tx: TxHandle,
  tenantId: string,
  q: z.infer<typeof TransferListQuery>,
): Promise<{ items: Transfer[]; nextCursor: string | null }> {
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
  const r = await tx.query<TransferRow>(
    `select ${TRANSFER_COLS} from procurement.transfers where ${where.join(" and ")}
      order by id desc limit $${String(params.length)}`,
    params,
  );
  const items = page(r.rows, q.limit);
  const lines = await linesFor(
    tx,
    tenantId,
    items.items.map((t) => t.id),
  );
  return {
    items: items.items.map((t) => toTransfer(t, lines.get(t.id) ?? [])),
    nextCursor: items.nextCursor,
  };
}

type CreateInput = z.infer<typeof CreateTransferSchema>;
type DispatchInput = z.infer<typeof DispatchTransferSchema>;
type ReceiveInput = z.infer<typeof ReceiveTransferSchema>;

export async function createTransferCommand(
  tx: TxHandle,
  ctx: CommandContext,
  b: CreateInput,
  deps: ProcurementDeps,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  assertDistinctLocations(b.fromLocationId, b.toLocationId);
  if (!(await deps.refs.locationExists(tx, tenantId, b.fromLocationId)))
    invalid("fromLocationId", "Unknown location.");
  if (!(await deps.refs.locationExists(tx, tenantId, b.toLocationId)))
    invalid("toLocationId", "Unknown location.");
  const known = await deps.refs.variantsExist(tx, tenantId, [
    ...new Set(b.lines.map((l) => l.variantId)),
  ]);
  b.lines.forEach((l, n) => {
    if (!known.has(l.variantId))
      invalid(`lines.${String(n)}.variantId`, "Unknown or archived variant.");
  });
  const seq = await tx.query<{ last_no: string }>(
    `insert into procurement.transfer_sequences (tenant_id, last_no) values ($1, 1)
     on conflict (tenant_id) do update set last_no = procurement.transfer_sequences.last_no + 1
     returning last_no::text as last_no`,
    [tenantId],
  );
  const id = ctx.ids.uuidv7();
  // The holding location belongs to this transfer alone: receive reads back exactly what dispatch put there.
  const inTransit = ctx.ids.uuidv7();
  await tx.query(
    `insert into procurement.transfers (tenant_id, id, transfer_no, from_location_id, to_location_id,
       in_transit_location_id, status, notes, requested_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9, $9)`,
    [
      tenantId,
      id,
      Number(one(seq.rows).last_no),
      b.fromLocationId,
      b.toLocationId,
      inTransit,
      b.notes,
      ctx.userId,
      ctx.now,
    ],
  );
  await tx.query(
    `insert into procurement.transfer_lines (tenant_id, transfer_id, line, variant_id, requested_qty)
     select $1, $2, x.line, x.variant_id, x.requested_qty::numeric
       from jsonb_to_recordset($3::jsonb) as x(line int, variant_id uuid, requested_qty text)`,
    [
      tenantId,
      id,
      JSON.stringify(
        b.lines.map((l, i) => ({
          line: i + 1,
          variant_id: l.variantId,
          requested_qty: l.requestedQty,
        })),
      ),
    ],
  );
  const after = await getTransfer(tx, tenantId, id);
  return {
    status: 201,
    body: after,
    audit: [
      {
        action: "procurement.transfer.created",
        entity: "procurement.transfer",
        entityId: id,
        after,
      },
    ],
    noEvents: true,
  };
}

/** Every line of the transfer must be sent exactly once. Returns the sent quantity per line number. */
function checkLines(
  lines: readonly { line: number }[],
  sent: readonly { line: number; qty?: string; receivedQty?: string }[],
  key: "qty" | "receivedQty",
): Map<number, string> {
  const known = new Set(lines.map((l) => l.line));
  const out = new Map<number, string>();
  sent.forEach((s, i) => {
    if (!known.has(s.line)) invalid(`lines.${String(i)}.line`, "Not a line of this transfer.");
    out.set(s.line, (key === "qty" ? s.qty : s.receivedQty) ?? "0");
  });
  if (out.size !== lines.length) invalid("lines", "Every line of the transfer must be included.");
  return out;
}

/** One ledger leg of one batch. The source line is unique within its document. */
const leg = (
  locationId: string,
  variantId: string,
  batchId: string,
  qty: string,
  reason: StockMovement["reason"],
  sourceLine: number,
  unitCostMinor: number,
): StockMovement => ({ locationId, variantId, batchId, qty, reason, sourceLine, unitCostMinor });

/**
 * Dispatch: stock leaves the source (FEFO over the batches that can serve each line, expired excluded) and lands in
 * the transfer's holding location, batch by batch. Two ledger movements per batch leg, in one transaction.
 */
export async function dispatchTransferCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: DispatchInput,
  deps: ProcurementDeps,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { row, lines } = await loadTransfer(tx, tenantId, id, true);
  requireVersion(row.version, b.version);
  assertTransferTransition(row.status, "dispatched");
  const sent = checkLines(lines, b.lines, "qty");
  lines.forEach((l, n) => {
    const qty = sent.get(l.line) ?? "0";
    if (toQty4(qty) > toQty4(l.requested_qty))
      invalid(`lines.${String(n)}.qty`, "More than was requested.");
  });
  // Lock the source stock first (key order), so two dispatches on one SKU serialise instead of overdrawing.
  await deps.stock.lockStock(
    tx,
    tenantId,
    row.from_location_id,
    lines.map((l) => l.variant_id),
  );
  const today = ctx.now.toISOString().slice(0, 10);
  const movements: StockMovement[] = [];
  const legs: { line: number; variantId: string; dispatched: string; valueMinor: number }[] = [];
  const currencies = new Set<string>();
  for (const l of lines) {
    const qty = sent.get(l.line) ?? "0";
    const fefo = await deps.stock.selectBatchesFefo(tx, tenantId, {
      locationId: row.from_location_id,
      variantId: l.variant_id,
      qty,
      today,
    });
    if (fefo.shortfall !== "0")
      throw conflict(`Not enough batch-tracked stock for line ${String(l.line)} at the source.`);
    if (fefo.allocations.length > MAX_DISPATCH_BATCHES)
      throw conflict(`Line ${String(l.line)} draws on too many batches. Dispatch it in parts.`);
    let value = 0;
    fefo.allocations.forEach((a, k) => {
      currencies.add(a.currency);
      value += lineTotalMinor(a.qty, a.unitCostMinor, a.currency);
      const base = l.line * 1000 + 2 * k;
      movements.push(
        leg(
          row.from_location_id,
          l.variant_id,
          a.batchId,
          `-${a.qty}`,
          "transfer_out",
          base,
          a.unitCostMinor,
        ),
        leg(
          row.in_transit_location_id,
          l.variant_id,
          a.batchId,
          a.qty,
          "transfer_in",
          base + 1,
          a.unitCostMinor,
        ),
      );
    });
    legs.push({ line: l.line, variantId: l.variant_id, dispatched: qty, valueMinor: value });
  }
  if (currencies.size > 1)
    throw conflict("The stock at the source is valued in more than one currency.");
  const currency = [...currencies][0] ?? "";
  const stock = await deps.stock.recordMovements(
    tx,
    ctx,
    { type: "transfer_dispatch", id, occurredAt: ctx.now },
    movements,
  );
  for (const g of legs) {
    await tx.query(
      `update procurement.transfer_lines set dispatched_qty = $4::numeric, value_minor = $5
        where tenant_id = $1 and transfer_id = $2 and line = $3`,
      [tenantId, id, g.line, g.dispatched, g.valueMinor],
    );
  }
  await tx.query(
    `update procurement.transfers set status = 'dispatched', currency = $3, version = version + 1,
        dispatched_at = $4, updated_at = $4
      where tenant_id = $1 and id = $2`,
    [tenantId, id, currency, ctx.now],
  );
  const reloaded = await loadTransfer(tx, tenantId, id, false);
  const after = toTransfer(reloaded.row, reloaded.lines);
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.transfer.dispatched",
        entity: "procurement.transfer",
        entityId: id,
        before: { status: row.status },
        after: { status: "dispatched", inTransitValueMinor: after.inTransitValueMinor },
      },
    ],
    events: [
      procurementEvent(TransferDispatchedV1, ctx, `transfer/${id}`, {
        transferId: id,
        transferNo: after.transferNo,
        fromLocationId: row.from_location_id,
        toLocationId: row.to_location_id,
        currency,
        valueMinor: after.inTransitValueMinor,
        lines: legs.map((g) => ({
          line: g.line,
          variantId: g.variantId,
          dispatchedQty: g.dispatched,
          valueMinor: g.valueMinor,
        })),
      }),
      ...stock.events,
    ],
  };
}

/**
 * Receive: the in-transit batches of each line are read back (FEFO, expired included, since stock can expire on the
 * road), the received quantity is split over them in that order, and each batch leg becomes ledger movements: out of
 * transit, into the destination, and the variance at transit (writeoff when short, count_variance when over). The
 * holding location is empty afterwards.
 */
export async function receiveTransferCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: ReceiveInput,
  deps: ProcurementDeps,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { row, lines } = await loadTransfer(tx, tenantId, id, true);
  requireVersion(row.version, b.version);
  assertTransferTransition(row.status, "received");
  const received = checkLines(lines, b.lines, "receivedQty");
  const tol = await tx.query<{ over_receipt_bps: number }>(
    "select over_receipt_bps from procurement.settings where tenant_id = $1",
    [tenantId],
  );
  const bps = tol.rows[0]?.over_receipt_bps ?? DEFAULT_OVER_RECEIPT_BPS;
  const today = ctx.now.toISOString().slice(0, 10);
  const movements: StockMovement[] = [];
  const result: {
    line: number;
    variantId: string;
    dispatched: string;
    received: string;
    variance: string;
  }[] = [];
  for (const [n, l] of lines.entries()) {
    const got = received.get(l.line) ?? "0";
    if (toQty4(got) > maxReceivable(l.dispatched_qty, bps)) {
      invalid(
        `lines.${String(n)}.receivedQty`,
        `Over-receipt beyond the ${String(bps / 100)}% tolerance (dispatched ${l.dispatched_qty}).`,
      );
    }
    const fefo = await deps.stock.selectBatchesFefo(tx, tenantId, {
      locationId: row.in_transit_location_id,
      variantId: l.variant_id,
      qty: normQty(l.dispatched_qty),
      today,
      includeExpired: true,
    });
    // Dispatch put exactly this quantity on the holding location, so a shortfall here means a broken ledger.
    /* v8 ignore next */
    if (fefo.shortfall !== "0") throw new Error("internal: in-transit stock is short");
    if (fefo.allocations.length > MAX_RECEIVE_BATCHES)
      throw conflict(`Line ${String(l.line)} spans too many batches to receive at once.`);
    const parts = receivedSplit(
      fefo.allocations.map((a) => toQty4(a.qty)),
      toQty4(got),
    );
    fefo.allocations.forEach((a, k) => {
      const r = parts[k] ?? 0n;
      const a4 = toQty4(a.qty);
      const base = l.line * 1000 + 3 * k;
      if (r > 0n) {
        movements.push(
          leg(
            row.in_transit_location_id,
            l.variant_id,
            a.batchId,
            `-${fromQty4(r)}`,
            "transfer_out",
            base,
            a.unitCostMinor,
          ),
          leg(
            row.to_location_id,
            l.variant_id,
            a.batchId,
            fromQty4(r),
            "transfer_in",
            base + 1,
            a.unitCostMinor,
          ),
        );
      }
      if (r !== a4) {
        movements.push(
          leg(
            row.in_transit_location_id,
            l.variant_id,
            a.batchId,
            fromQty4(r - a4),
            r < a4 ? "writeoff" : "count_variance",
            base + 2,
            a.unitCostMinor,
          ),
        );
      }
    });
    result.push({
      line: l.line,
      variantId: l.variant_id,
      dispatched: normQty(l.dispatched_qty),
      received: got,
      variance: varianceQty(l.dispatched_qty, got),
    });
  }
  const stock = await deps.stock.recordMovements(
    tx,
    ctx,
    { type: "transfer_receive", id, occurredAt: ctx.now },
    movements,
  );
  for (const g of result) {
    await tx.query(
      `update procurement.transfer_lines set received_qty = $4::numeric, variance_qty = $5::numeric
        where tenant_id = $1 and transfer_id = $2 and line = $3`,
      [tenantId, id, g.line, g.received, g.variance],
    );
  }
  await tx.query(
    `update procurement.transfers set status = 'received', version = version + 1, received_at = $3, updated_at = $3
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const reloaded = await loadTransfer(tx, tenantId, id, false);
  const after = toTransfer(reloaded.row, reloaded.lines);
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.transfer.received",
        entity: "procurement.transfer",
        entityId: id,
        before: { status: row.status },
        after: { status: "received", lines: result },
      },
    ],
    events: [
      procurementEvent(TransferReceivedV1, ctx, `transfer/${id}`, {
        transferId: id,
        transferNo: after.transferNo,
        fromLocationId: row.from_location_id,
        toLocationId: row.to_location_id,
        currency: row.currency ?? "",
        lines: result.map((g) => ({
          line: g.line,
          variantId: g.variantId,
          dispatchedQty: g.dispatched,
          receivedQty: g.received,
          varianceQty: g.variance,
        })),
      }),
      ...stock.events,
    ],
  };
}

/** Cancel is allowed only before dispatch: no stock has moved, so nothing needs reversing. */
export async function cancelTransferCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  version: number,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { row, lines } = await loadTransfer(tx, tenantId, id, true);
  requireVersion(row.version, version);
  assertTransferTransition(row.status, "cancelled");
  await tx.query(
    `update procurement.transfers set status = 'cancelled', version = version + 1, cancelled_at = $3, updated_at = $3
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const after = toTransfer(
    {
      ...row,
      status: "cancelled",
      version: row.version + 1,
      cancelled_at: ctx.now,
      updated_at: ctx.now,
    },
    lines,
  );
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.transfer.cancelled",
        entity: "procurement.transfer",
        entityId: id,
        before: { status: row.status },
        after: { status: "cancelled" },
      },
    ],
    noEvents: true,
  };
}

export async function closeTransferCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  version: number,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const { row, lines } = await loadTransfer(tx, tenantId, id, true);
  requireVersion(row.version, version);
  assertTransferTransition(row.status, "closed");
  await tx.query(
    `update procurement.transfers set status = 'closed', version = version + 1, closed_at = $3, updated_at = $3
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const after = toTransfer(
    { ...row, status: "closed", version: row.version + 1, closed_at: ctx.now, updated_at: ctx.now },
    lines,
  );
  const shortLines = after.lines.filter((l) => toQty4(l.varianceQty) < 0n).length;
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: "procurement.transfer.closed",
        entity: "procurement.transfer",
        entityId: id,
        before: { status: row.status },
        after: { status: "closed", shortLines },
      },
    ],
    events: [
      procurementEvent(TransferClosedV1, ctx, `transfer/${id}`, {
        transferId: id,
        transferNo: after.transferNo,
        toLocationId: row.to_location_id,
        shortLines,
      }),
    ],
  };
}
