import { DomainError } from "@wise-biz/errors";

import {
  daysBetween,
  MARKDOWN_WINDOW_DAYS,
  NEAR_EXPIRY_DEFAULT_DAYS,
  suggestMarkdownPercent,
  utcDate,
  WRITEOFF_HORIZON_DAYS,
} from "../domain/expiry.ts";
import { fefoCompliance } from "../domain/fefo.ts";
import { fromQty4, lineValueMinor, NO_BATCH, normQty, toQty4 } from "../domain/qty.ts";
import { ExpiryMarkdownSuggestedV1 } from "../events.ts";
import { lockStock, recordMovements } from "../port.ts";

import { inventoryEvent, invalid, one } from "./shared.ts";

import type { LocationExists } from "./stock.ts";
import type { FefoBatchRow, FefoMovementRow, FefoOutflowRow } from "../domain/fefo.ts";
import type { WriteOffSchema } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Ledger window of the FEFO report: at most one quarter per call. */
export const FEFO_MAX_DAYS = 92;
/** Reasons that take stock out of a batch as a sale or a transfer (write-offs and expiry are losses, not consumption). */
const CONSUMPTION_REASONS = ["sale", "transfer_out"] as const;

// --- Near-expiry list ---

export interface NearExpiryQuery {
  readonly days?: number | undefined;
  readonly locationId?: string | undefined;
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

export interface NearExpiryItem {
  batchId: string;
  variantId: string;
  locationId: string;
  lotCode: string | null;
  expiresOn: string;
  /** Negative: already expired (still listed, so the stock is not forgotten). */
  daysLeft: number;
  qtyOnHand: string;
  unitCostMinor: number;
  /** qty x batch unit cost, in the batch currency, rounded half away from zero. */
  valueMinor: number;
  currency: string;
  salePriceMinor: number | null;
}

export interface NearExpiryPage {
  asOf: string;
  days: number;
  items: NearExpiryItem[];
  nextCursor: string | null;
}

interface NearExpiryRow {
  batch_id: string;
  variant_id: string;
  location_id: string;
  lot_code: string | null;
  expires_on: string;
  qty: string;
  unit_cost_minor: string;
  currency: string;
  sale_price_minor: string | null;
}

/** Keyset cursor: "expiresOn|batchId|locationId". Strict parse: a malformed cursor is a 422, never a silent first page. */
function decodeCursor(after: string | undefined): [string, string, string] | null {
  if (after === undefined) return null;
  const parts = after.split("|");
  const [d, b, l] = parts;
  if (
    parts.length !== 3 ||
    d === undefined ||
    b === undefined ||
    l === undefined ||
    !ISO_DATE.test(d) ||
    !UUID.test(b) ||
    !UUID.test(l)
  ) {
    return invalid("after", "Malformed cursor.");
  }
  return [d, b, l];
}

/**
 * Batches with positive on-hand at a location (or all locations) whose expiry is within `days` of today (UTC),
 * expired ones included. Ordered by expiry, then batch and location. Uses batches_tenant_expiry_idx for the range and
 * stock_balances_tenant_variant_idx (or the PK prefix) for the balance of each batch.
 */
export async function listNearExpiry(
  tx: TxHandle,
  tenantId: string,
  q: NearExpiryQuery,
  nowMs: number,
): Promise<NearExpiryPage> {
  const days = q.days ?? NEAR_EXPIRY_DEFAULT_DAYS;
  const limit = q.limit ?? 50;
  const today = utcDate(nowMs);
  const horizon = utcDate(nowMs + days * DAY_MS);
  const cursor = decodeCursor(q.after);
  const params: unknown[] = [tenantId, horizon];
  const where = [
    "b.tenant_id = $1",
    "b.expires_on is not null",
    "b.expires_on <= $2::date",
    "s.qty > 0",
  ];
  if (q.locationId !== undefined) {
    params.push(q.locationId);
    where.push(`s.location_id = $${String(params.length)}::uuid`);
  }
  if (cursor !== null) {
    params.push(cursor[0], cursor[1], cursor[2]);
    const n = params.length;
    where.push(
      `(b.expires_on, b.id, s.location_id) > ($${String(n - 2)}::date, $${String(n - 1)}::uuid, $${String(n)}::uuid)`,
    );
  }
  params.push(limit + 1);
  const r = await tx.query<NearExpiryRow>(
    `select b.id as batch_id, b.variant_id, s.location_id, b.lot_code, b.expires_on::text as expires_on,
       s.qty::text as qty, b.unit_cost_minor::text as unit_cost_minor, b.currency,
       b.sale_price_minor::text as sale_price_minor
     from inventory.batches b
     join inventory.stock_balances s
       on s.tenant_id = b.tenant_id and s.variant_id = b.variant_id and s.batch_id = b.id
     where ${where.join(" and ")}
     order by b.expires_on, b.id, s.location_id
     limit $${String(params.length)}`,
    params,
  );
  const page = r.rows.slice(0, limit);
  const items: NearExpiryItem[] = page.map((x) => {
    const unit = Number(x.unit_cost_minor);
    return {
      batchId: x.batch_id,
      variantId: x.variant_id,
      locationId: x.location_id,
      lotCode: x.lot_code,
      expiresOn: x.expires_on,
      daysLeft: daysBetween(today, x.expires_on),
      qtyOnHand: normQty(x.qty),
      unitCostMinor: unit,
      valueMinor: lineValueMinor(toQty4(x.qty), unit),
      currency: x.currency,
      salePriceMinor: x.sale_price_minor === null ? null : Number(x.sale_price_minor),
    };
  });
  const last = page[page.length - 1];
  return {
    asOf: today,
    days,
    items,
    nextCursor:
      r.rows.length > limit && last !== undefined
        ? `${last.expires_on}|${last.batch_id}|${last.location_id}`
        : null,
  };
}

// --- Markdown suggestion (draft request) ---

export interface MarkdownSuggestion {
  batchId: string;
  variantId: string;
  locationId: string;
  expiresOn: string;
  daysLeft: number;
  percent: number;
  state: "draft";
  stockAheadQty: string;
  soldQty: string;
  windowDays: number;
  currency: string;
  salePriceMinor: number | null;
}

/**
 * Records a promotion DRAFT for one batch as `inventory.expiry.markdown_suggested@v1` (the pricing module decides and
 * applies it later). Nothing is priced here and no pricing table is read. Refuses expired batches (write them off) and
 * batches where the rule gives 0%, so the draft never carries a no-op.
 */
export async function markdownSuggestionCommand(
  tx: TxHandle,
  ctx: CommandContext,
  b: { readonly locationId: string; readonly batchId: string },
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const today = utcDate(ctx.now.getTime());
  const head = await tx.query<{
    variant_id: string;
    expires_on: string | null;
    currency: string;
    sale_price_minor: string | null;
    qty: string;
    reserved: string;
  }>(
    `select b.variant_id, b.expires_on::text as expires_on, b.currency,
       b.sale_price_minor::text as sale_price_minor, s.qty::text as qty, s.reserved::text as reserved
     from inventory.batches b
     join inventory.stock_balances s
       on s.tenant_id = b.tenant_id and s.variant_id = b.variant_id and s.batch_id = b.id
     where b.tenant_id = $1 and b.id = $2 and s.location_id = $3`,
    [tenantId, b.batchId, b.locationId],
  );
  const h = head.rows[0];
  if (h === undefined) return invalid("batchId", "No stock of this batch at this location.");
  if (h.expires_on === null) return invalid("batchId", "This batch has no expiry date.");
  const daysLeft = daysBetween(today, h.expires_on);
  if (daysLeft < 0) {
    throw new DomainError("CONFLICT", "This batch has expired. Write it off instead.");
  }
  if (toQty4(h.qty) - toQty4(h.reserved) <= 0n) {
    throw new DomainError("CONFLICT", "No available stock of this batch.");
  }
  // Stock ahead: available stock of this variant at the location that expires no later (FEFO sells it first).
  const ahead = await tx.query<{ ahead: string }>(
    `select coalesce(sum(s.qty - s.reserved), 0)::text as ahead
     from inventory.stock_balances s
     join inventory.batches x on x.tenant_id = s.tenant_id and x.id = s.batch_id
     where s.tenant_id = $1 and s.location_id = $2 and s.variant_id = $3
       and s.qty - s.reserved > 0 and x.expires_on <= $4::date`,
    [tenantId, b.locationId, h.variant_id, h.expires_on],
  );
  const sold = await tx.query<{ sold: string }>(
    `select coalesce(-sum(qty), 0)::text as sold from inventory.stock_movements
     where tenant_id = $1 and location_id = $2 and variant_id = $3 and reason = 'sale'
       and occurred_at >= $4 and occurred_at < $5`,
    [
      tenantId,
      b.locationId,
      h.variant_id,
      new Date(ctx.now.getTime() - MARKDOWN_WINDOW_DAYS * DAY_MS),
      ctx.now,
    ],
  );
  const aheadQty = one(ahead.rows).ahead;
  const soldQty = one(sold.rows).sold;
  const percent = suggestMarkdownPercent({
    daysLeft,
    stockAhead4: toQty4(aheadQty),
    sold4: toQty4(soldQty),
  });
  if (percent === 0) {
    throw new DomainError("CONFLICT", "No markdown applies to this batch today.");
  }
  const salePriceMinor = h.sale_price_minor === null ? null : Number(h.sale_price_minor);
  const body: MarkdownSuggestion = {
    batchId: b.batchId,
    variantId: h.variant_id,
    locationId: b.locationId,
    expiresOn: h.expires_on,
    daysLeft,
    percent,
    state: "draft",
    stockAheadQty: normQty(aheadQty),
    soldQty: normQty(soldQty),
    windowDays: MARKDOWN_WINDOW_DAYS,
    currency: h.currency,
    salePriceMinor,
  };
  const event = inventoryEvent(
    ExpiryMarkdownSuggestedV1,
    ctx,
    `expiry/${b.batchId}`,
    body,
    h.variant_id,
  );
  return {
    status: 201,
    body,
    audit: [
      {
        action: "inventory.expiry.markdown_suggested",
        entity: "inventory.batch",
        entityId: b.batchId,
        after: body,
      },
    ],
    events: [event],
  };
}

// --- Write-off (through the ledger, as an adjustment with reason writeoff) ---

type WriteOffInput = z.output<typeof WriteOffSchema>;

interface StockRow {
  variant_id: string;
  batch_id: string;
  qty: string;
  reserved: string;
  expires_on: string | null;
  unit_cost_minor: string;
  currency: string;
}

const pairKey = (variantId: string, batchId: string): string => `${variantId}|${batchId}`;

/**
 * Writes off expired or expiring stock (expiry within WRITEOFF_HORIZON_DAYS, expired included) as a document: an
 * adjustment with reason writeoff, its lines, and `recordMovements` with movement reason writeoff, all in this
 * transaction, with audit and outbox. FEFO-consistent: a line is refused while an earlier-expiring batch of the same
 * variant at the location (not yet expired, the same rule as the FEFO report) still holds available stock after the
 * document. Available = qty - reserved; the document never takes reserved stock.
 */
export async function writeOffCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: WriteOffInput,
  locationExists: LocationExists,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const today = utcDate(ctx.now.getTime());
  if (!(await locationExists(tx, tenantId, input.locationId))) {
    invalid("locationId", "Unknown location.");
  }
  const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
  const facts = await tx.query<{ variant_id: string; tracks_batches: boolean; archived: boolean }>(
    `select variant_id, tracks_batches, archived from inventory.variant_facts
     where tenant_id = $1 and variant_id = any($2::uuid[])`,
    [tenantId, variantIds],
  );
  const factOf = new Map(facts.rows.map((f) => [f.variant_id, f]));
  input.lines.forEach((l, i) => {
    const f = factOf.get(l.variantId);
    if (f === undefined || f.archived) {
      return invalid(`lines.${String(i)}.variantId`, "Unknown or archived variant.");
    }
    if (!f.tracks_batches) {
      return invalid(`lines.${String(i)}.batchId`, "This variant does not track batches.");
    }
  });

  // Same lock order as every other ledger writer: balances of these variants at this location, by key.
  await lockStock(tx, tenantId, input.locationId, variantIds);
  const stock = await tx.query<StockRow>(
    `select s.variant_id, s.batch_id, s.qty::text as qty, s.reserved::text as reserved,
       x.expires_on::text as expires_on, x.unit_cost_minor::text as unit_cost_minor, x.currency
     from inventory.stock_balances s
     join inventory.batches x on x.tenant_id = s.tenant_id and x.id = s.batch_id
     where s.tenant_id = $1 and s.location_id = $2 and s.variant_id = any($3::uuid[]) and s.batch_id <> $4`,
    [tenantId, input.locationId, variantIds, NO_BATCH],
  );
  const rowOf = new Map(stock.rows.map((r) => [pairKey(r.variant_id, r.batch_id), r]));

  const currencies = new Set<string>();
  const docOut = new Map<string, bigint>();
  input.lines.forEach((l, i) => {
    const row = rowOf.get(pairKey(l.variantId, l.batchId));
    if (row === undefined) {
      return invalid(`lines.${String(i)}.batchId`, "No stock of this batch at this location.");
    }
    if (row.expires_on === null || daysBetween(today, row.expires_on) > WRITEOFF_HORIZON_DAYS) {
      return invalid(
        `lines.${String(i)}.batchId`,
        `Only stock that is expired or expires within ${String(WRITEOFF_HORIZON_DAYS)} days can be written off.`,
      );
    }
    const available = toQty4(row.qty) - toQty4(row.reserved);
    const qty4 = toQty4(l.qty);
    if (qty4 > available) {
      throw new DomainError("CONFLICT", `Only ${fromQty4(available)} is available to write off.`);
    }
    currencies.add(row.currency);
    docOut.set(pairKey(l.variantId, l.batchId), qty4);
  });
  if (currencies.size > 1) return invalid("lines", "One write-off takes one currency.");

  // FEFO guard: no later-expiring line while an earlier-expiring batch (not yet expired) still holds stock after this document.
  for (const l of input.lines) {
    const line = rowOf.get(pairKey(l.variantId, l.batchId));
    if (line === undefined || line.expires_on === null) continue;
    for (const other of stock.rows) {
      if (other.variant_id !== l.variantId || other.batch_id === l.batchId) continue;
      if (
        other.expires_on === null ||
        other.expires_on < today ||
        other.expires_on >= line.expires_on
      ) {
        continue;
      }
      const left =
        toQty4(other.qty) -
        toQty4(other.reserved) -
        (docOut.get(pairKey(other.variant_id, other.batch_id)) ?? 0n);
      if (left > 0n) {
        throw new DomainError(
          "CONFLICT",
          "An earlier-expiring batch of this variant still holds stock. Write that one off first (FEFO).",
        );
      }
    }
  }

  const costs = input.lines.map((l) =>
    Number(rowOf.get(pairKey(l.variantId, l.batchId))?.unit_cost_minor ?? 0),
  );
  const lineValues = input.lines.map((l, i) => lineValueMinor(toQty4(l.qty), costs[i] ?? 0));
  const value = lineValues.reduce((a, v) => a + v, 0);
  const currency = [...currencies][0] ?? "";
  const id = ctx.ids.uuidv7();
  await tx.query(
    `insert into inventory.adjustments (tenant_id, id, location_id, reason, note, value_minor, created_by, created_at)
     values ($1, $2, $3, 'writeoff', $4, $5, $6, $7)`,
    [tenantId, id, input.locationId, input.note ?? null, value, ctx.userId, ctx.now],
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
          batch_id: l.batchId,
          qty: fromQty4(-toQty4(l.qty)),
          unit_cost_minor: costs[i] ?? 0,
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
      batchId: l.batchId,
      qty: fromQty4(-toQty4(l.qty)),
      reason: "writeoff" as const,
      sourceLine: i,
      unitCostMinor: costs[i] ?? null,
    })),
  );
  const body = {
    id,
    locationId: input.locationId,
    valueMinor: value,
    currency,
    lines: input.lines.map((l, i) => ({
      variantId: l.variantId,
      batchId: l.batchId,
      qty: fromQty4(toQty4(l.qty)),
      unitCostMinor: costs[i] ?? 0,
      valueMinor: lineValues[i] ?? 0,
    })),
    balances: recorded.balances,
  };
  return {
    status: 201,
    body,
    audit: [
      {
        action: "inventory.expiry.written_off",
        entity: "inventory.adjustment",
        entityId: id,
        after: body,
      },
    ],
    events: recorded.events,
  };
}

// --- FEFO compliance report ---

export interface FefoReportQuery {
  readonly from: string;
  readonly to: string;
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

export interface FefoReportItem {
  variantId: string;
  /** Sales and transfers out of a batch in the window. */
  outflows: number;
  violations: number;
  violatedQty: string;
}

export interface FefoReportPage {
  from: string;
  to: string;
  items: FefoReportItem[];
  nextCursor: string | null;
}

/**
 * Sales and transfers that took stock from a later-expiring batch while an earlier-expiring batch of the same variant
 * at the same location held stock (rule in domain/fefo.ts), counted per variant for [from, to] (UTC, inclusive).
 * Three set reads (outflows in the window; the batches of those location-variant pairs; their movements since `from`):
 * no per-row round trip. Balances are rebuilt from the ledger since `from`, so the window needs no opening snapshot.
 */
export async function fefoReport(
  tx: TxHandle,
  tenantId: string,
  q: FefoReportQuery,
): Promise<FefoReportPage> {
  if (!ISO_DATE.test(q.from) || !ISO_DATE.test(q.to)) invalid("from", "Dates are YYYY-MM-DD.");
  const fromMs = Date.parse(`${q.from}T00:00:00Z`);
  const toMs = Date.parse(`${q.to}T00:00:00Z`) + DAY_MS;
  if (toMs <= fromMs) invalid("to", "The window ends after it starts.");
  if (toMs - fromMs > FEFO_MAX_DAYS * DAY_MS) {
    invalid("to", `The window is at most ${String(FEFO_MAX_DAYS)} days.`);
  }
  const limit = q.limit ?? 50;
  if (q.after !== undefined && !UUID.test(q.after)) invalid("after", "Malformed cursor.");

  const outRows = await tx.query<{
    location_id: string;
    variant_id: string;
    batch_id: string;
    qty: string;
    occurred_at: Date;
    expires_on: string | null;
  }>(
    `select m.location_id, m.variant_id, m.batch_id, m.qty::text as qty, m.occurred_at,
       b.expires_on::text as expires_on
     from inventory.stock_movements m
     left join inventory.batches b on b.tenant_id = m.tenant_id and b.id = m.batch_id
     where m.tenant_id = $1 and m.occurred_at >= $2 and m.occurred_at < $3
       and m.reason = any($4::text[]) and m.qty < 0 and m.batch_id is not null`,
    [tenantId, new Date(fromMs), new Date(toMs), CONSUMPTION_REASONS],
  );
  const outflows: FefoOutflowRow[] = outRows.rows.map((r) => ({
    locationId: r.location_id,
    variantId: r.variant_id,
    batchId: r.batch_id,
    qty4: toQty4(r.qty),
    occurredAt: r.occurred_at.getTime(),
    expiresOn: r.expires_on,
  }));

  const pairs = new Map<string, [string, string]>();
  for (const o of outflows)
    pairs.set(`${o.locationId}|${o.variantId}`, [o.locationId, o.variantId]);
  const locs = [...pairs.values()].map((p) => p[0]);
  const vars = [...pairs.values()].map((p) => p[1]);
  let batches: FefoBatchRow[] = [];
  let movements: FefoMovementRow[] = [];
  if (pairs.size > 0) {
    const bal = await tx.query<{
      location_id: string;
      variant_id: string;
      batch_id: string;
      qty: string;
      expires_on: string | null;
    }>(
      `with p as (select * from unnest($2::uuid[], $3::uuid[]) as p(location_id, variant_id))
       select s.location_id, s.variant_id, s.batch_id, s.qty::text as qty, x.expires_on::text as expires_on
       from inventory.stock_balances s
       join p on p.location_id = s.location_id and p.variant_id = s.variant_id
       join inventory.batches x on x.tenant_id = s.tenant_id and x.id = s.batch_id
       where s.tenant_id = $1`,
      [tenantId, locs, vars],
    );
    batches = bal.rows.map((r) => ({
      locationId: r.location_id,
      variantId: r.variant_id,
      batchId: r.batch_id,
      expiresOn: r.expires_on,
      currentQty4: toQty4(r.qty),
    }));
    const mov = await tx.query<{
      location_id: string;
      variant_id: string;
      batch_id: string;
      qty: string;
      occurred_at: Date;
    }>(
      `with p as (select * from unnest($2::uuid[], $3::uuid[]) as p(location_id, variant_id))
       select m.location_id, m.variant_id, m.batch_id, m.qty::text as qty, m.occurred_at
       from inventory.stock_movements m
       join p on p.location_id = m.location_id and p.variant_id = m.variant_id
       where m.tenant_id = $1 and m.occurred_at >= $4 and m.batch_id is not null`,
      [tenantId, locs, vars, new Date(fromMs)],
    );
    movements = mov.rows.map((r) => ({
      locationId: r.location_id,
      variantId: r.variant_id,
      batchId: r.batch_id,
      occurredAt: r.occurred_at.getTime(),
      qty4: toQty4(r.qty),
    }));
  }

  const rows = fefoCompliance({ fromMs, toMs, outflows, batches, movements }).filter(
    (r) => q.after === undefined || r.variantId > q.after,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    from: q.from,
    to: q.to,
    items: page.map((r) => ({
      variantId: r.variantId,
      outflows: r.outflows,
      violations: r.violations,
      violatedQty: fromQty4(r.violatedQty4),
    })),
    nextCursor: rows.length > limit && last !== undefined ? last.variantId : null,
  };
}
