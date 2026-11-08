import { DomainError } from "@wise-biz/errors";

import { inventoryEvent } from "./application/shared.ts";
import { fromQty4, NO_BATCH, normQty, toQty4 } from "./domain/qty.ts";
import { BalanceNegativeV1, MovementRecordedV1 } from "./events.ts";

import type { OutboxEvent, TxHandle } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";

export type MovementReason =
  | "sale"
  | "return"
  | "receive"
  | "adjust"
  | "transfer_in"
  | "transfer_out"
  | "count_variance"
  | "writeoff"
  | "expiry";

export interface MovementInput {
  readonly locationId: string;
  readonly variantId: string;
  readonly batchId?: string | null;
  /** Decimal string, signed (+ in, - out), base unit, up to 4 places. Never zero. */
  readonly qty: string;
  readonly reason: MovementReason;
  readonly sourceLine: number;
  readonly unitCostMinor?: number | null;
}

export interface Source {
  readonly type: string;
  readonly id: string;
  /** The document's time: part of the idempotency key, so a replay must send the same instant. */
  readonly occurredAt: Date;
}

export interface Balance {
  readonly locationId: string;
  readonly variantId: string;
  readonly batchId: string | null;
  readonly qty: string;
  readonly reserved: string;
}

export interface RecordResult {
  /** Movements actually inserted (0 on a replay). */
  readonly inserted: number;
  readonly balances: readonly Balance[];
  /** Outbox events for the caller to commit in the same transaction (movement.recorded, balance.negative). */
  readonly events: readonly OutboxEvent[];
}

interface BalanceRow {
  location_id: string;
  variant_id: string;
  batch_id: string;
  qty: string;
  reserved: string;
}
const toBalance = (r: BalanceRow): Balance => ({
  locationId: r.location_id,
  variantId: r.variant_id,
  batchId: r.batch_id === NO_BATCH ? null : r.batch_id,
  qty: normQty(r.qty),
  reserved: normQty(r.reserved),
});

/**
 * Call once per document per transaction (lock order is guaranteed within one statement).
 * Ledger insert + balance upsert in ONE statement: new movements only (`on conflict do nothing` on the source key),
 * their deltas grouped per balance key, upserted in key order. Every transaction locks balance rows in the same
 * order, so concurrent sales and receipts on one SKU never deadlock and never lose an update.
 */
export async function recordMovements(
  tx: TxHandle,
  ctx: CommandContext,
  source: Source,
  movements: readonly MovementInput[],
  opts: { readonly sellExpired?: boolean } = {},
): Promise<RecordResult> {
  if (movements.length === 0) return { inserted: 0, balances: [], events: [] };
  if (new Set(movements.map((m) => m.sourceLine)).size !== movements.length) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Each movement of a document needs its own sourceLine.",
    );
  }
  const tenantId = ctx.tenant.tenantId;
  const rows = movements.map((m) => {
    if (toQty4(m.qty) === 0n)
      throw new DomainError("VALIDATION_FAILED", "A movement cannot be zero.");
    return {
      id: ctx.ids.uuidv7(),
      location_id: m.locationId,
      variant_id: m.variantId,
      batch_id: m.batchId ?? null,
      qty: m.qty,
      reason: m.reason,
      source_line: m.sourceLine,
      unit_cost_minor: m.unitCostMinor ?? null,
    };
  });
  const soldBatches = [
    ...new Set(
      rows.filter((r) => r.reason === "sale" && r.batch_id !== null).map((r) => r.batch_id),
    ),
  ];
  if (soldBatches.length > 0 && opts.sellExpired !== true) {
    const expired = await tx.query<{ id: string }>(
      `select id from inventory.batches
       where tenant_id = $1 and id = any($2::uuid[]) and expires_on < ($3::timestamptz at time zone 'UTC')::date`,
      [tenantId, soldBatches, source.occurredAt],
    );
    if (expired.rows.length > 0) {
      throw new DomainError("PRECONDITION_FAILED", "This batch has expired.", {
        details: { permission: "inventory:sell_expired", batchIds: expired.rows.map((r) => r.id) },
      });
    }
  }
  const r = await tx.query<BalanceRow & { inserted: string }>(
    `with input as (
       select * from jsonb_to_recordset($2::jsonb) as m(id uuid, location_id uuid, variant_id uuid, batch_id uuid,
         qty numeric, reason text, source_line int, unit_cost_minor bigint)
     ), ins as (
       insert into inventory.stock_movements (tenant_id, id, location_id, variant_id, batch_id, qty, reason, source_type,
         source_id, source_line, unit_cost_minor, occurred_at, recorded_at)
       select $1, id, location_id, variant_id, batch_id, qty, reason, $3, $4, source_line, unit_cost_minor, $5, $6
       from input
       on conflict (tenant_id, source_type, source_id, source_line, occurred_at) do nothing
       returning location_id, variant_id, coalesce(batch_id, '${NO_BATCH}'::uuid) as batch_id, qty
     ), deltas as (
       select location_id, variant_id, batch_id, sum(qty) as qty, count(*) as n from ins
       group by location_id, variant_id, batch_id
     ), up as (
       insert into inventory.stock_balances (tenant_id, location_id, variant_id, batch_id, qty, updated_at)
       select $1, location_id, variant_id, batch_id, qty, $6 from deltas
       order by location_id, variant_id, batch_id
       on conflict (tenant_id, location_id, variant_id, batch_id) do update
         set qty = inventory.stock_balances.qty + excluded.qty, version = inventory.stock_balances.version + 1,
           updated_at = excluded.updated_at
       returning location_id, variant_id, batch_id, qty::text, reserved::text
     )
     select up.*, (select coalesce(sum(n), 0) from deltas)::text as inserted from up
     order by location_id, variant_id, batch_id`,
    [tenantId, JSON.stringify(rows), source.type, source.id, source.occurredAt, ctx.now],
  );
  const inserted = Number(r.rows[0]?.inserted ?? 0);
  const balances = r.rows.map(toBalance);
  if (inserted === 0) return { inserted, balances, events: [] };
  const occurredAt = source.occurredAt.toISOString();
  const variantIds = [...new Set(rows.map((m) => m.variant_id))].sort();
  const events: OutboxEvent[] = [
    // One per SKU: the inventory topic is keyed by variant, so each SKU's events stay in order.
    ...variantIds.map((variantId) =>
      inventoryEvent(
        MovementRecordedV1,
        ctx,
        `${source.type}/${source.id}`,
        {
          variantId,
          sourceType: source.type,
          sourceId: source.id,
          occurredAt,
          movements: rows
            .filter((m) => m.variant_id === variantId)
            .map((m) => ({
              locationId: m.location_id,
              batchId: m.batch_id,
              qty: fromQty4(toQty4(m.qty)),
              reason: m.reason,
            })),
          balances: balances
            .filter((x) => x.variantId === variantId)
            .map((x) => ({
              locationId: x.locationId,
              batchId: x.batchId,
              qty: x.qty,
              reserved: x.reserved,
            })),
        },
        variantId,
      ),
    ),
    ...balances
      .filter((x) => toQty4(x.qty) < 0n)
      .map((x) =>
        inventoryEvent(
          BalanceNegativeV1,
          ctx,
          `balance/${x.locationId}/${x.variantId}`,
          {
            locationId: x.locationId,
            variantId: x.variantId,
            batchId: x.batchId,
            qty: x.qty,
            sourceType: source.type,
            sourceId: source.id,
          },
          x.variantId,
        ),
      ),
  ];
  return { inserted, balances, events };
}

export interface FefoAllocation {
  readonly batchId: string;
  readonly qty: string;
  readonly expiresOn: string | null;
  /** The batch's own unit cost and currency: what a transfer values its stock at. */
  readonly unitCostMinor: number;
  readonly currency: string;
}

/**
 * First-expired-first-out over batches with available stock (qty - reserved) at the location. Expired batches are
 * skipped unless `includeExpired`. `shortfall` > 0 when the batches cannot cover the quantity (the caller decides:
 * offline sales still go through and the balance goes negative).
 */
export async function selectBatchesFefo(
  tx: TxHandle,
  tenantId: string,
  q: {
    readonly locationId: string;
    readonly variantId: string;
    readonly qty: string;
    readonly today: string;
    readonly includeExpired?: boolean;
  },
): Promise<{ allocations: FefoAllocation[]; shortfall: string }> {
  const r = await tx.query<{
    batch_id: string;
    available: string;
    expires_on: string | null;
    unit_cost_minor: string;
    currency: string;
  }>(
    `select s.batch_id, (s.qty - s.reserved)::text as available, b.expires_on::text,
       b.unit_cost_minor::text as unit_cost_minor, b.currency
     from inventory.stock_balances s
     join inventory.batches b on b.tenant_id = s.tenant_id and b.id = s.batch_id
     where s.tenant_id = $1 and s.location_id = $2 and s.variant_id = $3 and s.qty - s.reserved > 0
       and ($5 or b.expires_on is null or b.expires_on >= $4::date)
     order by b.expires_on nulls last, b.received_at, b.id`,
    [tenantId, q.locationId, q.variantId, q.today, q.includeExpired === true],
  );
  let left = toQty4(q.qty);
  const allocations: FefoAllocation[] = [];
  for (const row of r.rows) {
    if (left <= 0n) break;
    const take = (() => {
      const a = toQty4(row.available);
      return a < left ? a : left;
    })();
    allocations.push({
      batchId: row.batch_id,
      qty: fromQty4(take),
      expiresOn: row.expires_on,
      unitCostMinor: Number(row.unit_cost_minor),
      currency: row.currency,
    });
    left -= take;
  }
  return { allocations, shortfall: fromQty4(left > 0n ? left : 0n) };
}

/**
 * Locks the stock rows of these variants at one location, in the same key order recordMovements upserts them. A
 * document that draws on stock (a transfer dispatch) calls this before selectBatchesFefo, so two of them on one SKU
 * serialise instead of overdrawing the balance.
 */
export async function lockStock(
  tx: TxHandle,
  tenantId: string,
  locationId: string,
  variantIds: readonly string[],
): Promise<void> {
  if (variantIds.length === 0) return;
  await tx.query(
    `select 1 from inventory.stock_balances
      where tenant_id = $1 and location_id = $2 and variant_id = any($3::uuid[])
      order by variant_id, batch_id for update`,
    [tenantId, locationId, [...new Set(variantIds)].sort()],
  );
}

export interface ReserveInput {
  readonly locationId: string;
  readonly variantId: string;
  readonly batchId?: string | null;
  readonly qty: string;
  readonly sourceLine: number;
}

/**
 * Soft holds for a document (online order, layaway). Idempotent per (source, line, batch). Fails with 409 and rolls
 * back when a hold would exceed what is on hand, unless `allowOversell`.
 */
export async function reserve(
  tx: TxHandle,
  ctx: CommandContext,
  source: { readonly type: string; readonly id: string; readonly expiresAt?: Date | null },
  lines: readonly ReserveInput[],
  opts: { readonly allowOversell?: boolean } = {},
): Promise<readonly Balance[]> {
  if (lines.length === 0) return [];
  const rows = lines.map((l) => {
    if (toQty4(l.qty) <= 0n)
      throw new DomainError("VALIDATION_FAILED", "A reservation must be positive.");
    return {
      id: ctx.ids.uuidv7(),
      location_id: l.locationId,
      variant_id: l.variantId,
      batch_id: l.batchId ?? NO_BATCH,
      qty: l.qty,
      source_line: l.sourceLine,
    };
  });
  const r = await tx.query<BalanceRow>(
    `with input as (
       select * from jsonb_to_recordset($2::jsonb) as m(id uuid, location_id uuid, variant_id uuid, batch_id uuid,
         qty numeric, source_line int)
     ), ins as (
       insert into inventory.reservations (tenant_id, id, location_id, variant_id, batch_id, qty, source_type, source_id,
         source_line, expires_at, created_at, updated_at)
       select $1, id, location_id, variant_id, batch_id, qty, $3, $4, source_line, $5, $6, $6 from input
       on conflict (tenant_id, source_type, source_id, source_line, batch_id) do nothing
       returning location_id, variant_id, batch_id, qty
     ), deltas as (
       select location_id, variant_id, batch_id, sum(qty) as qty from ins group by location_id, variant_id, batch_id
     )
     insert into inventory.stock_balances (tenant_id, location_id, variant_id, batch_id, qty, reserved, updated_at)
     select $1, location_id, variant_id, batch_id, 0, qty, $6 from deltas order by location_id, variant_id, batch_id
     on conflict (tenant_id, location_id, variant_id, batch_id) do update
       set reserved = inventory.stock_balances.reserved + excluded.reserved,
         version = inventory.stock_balances.version + 1, updated_at = excluded.updated_at
     returning location_id, variant_id, batch_id, qty::text, reserved::text`,
    [
      ctx.tenant.tenantId,
      JSON.stringify(rows),
      source.type,
      source.id,
      source.expiresAt ?? null,
      ctx.now,
    ],
  );
  const balances = r.rows.map(toBalance);
  if (opts.allowOversell !== true && balances.some((b) => toQty4(b.reserved) > toQty4(b.qty))) {
    throw new DomainError("CONFLICT", "Not enough stock to reserve.");
  }
  return balances;
}

interface HeldLine {
  locationId: string;
  variantId: string;
  batchId: string;
  qty: string;
  line: number;
}

/** Releases (status released) or commits (status committed) a document's open holds and frees their reserved qty. */
async function settle(
  tx: TxHandle,
  ctx: CommandContext,
  source: { readonly type: string; readonly id: string },
  to: "released" | "committed",
): Promise<HeldLine[]> {
  const tenantId = ctx.tenant.tenantId;
  // Lock the document's holds in id order first: two settles of one document never deadlock.
  await tx.query(
    `select 1 from inventory.reservations
     where tenant_id = $1 and source_type = $2 and source_id = $3 and status = 'open' order by id for update`,
    [tenantId, source.type, source.id],
  );
  const done = await tx.query<{
    location_id: string;
    variant_id: string;
    batch_id: string;
    qty: string;
    source_line: number;
  }>(
    `update inventory.reservations set status = $4, updated_at = $5
     where tenant_id = $1 and source_type = $2 and source_id = $3 and status = 'open'
     returning location_id, variant_id, batch_id, qty::text, source_line`,
    [tenantId, source.type, source.id, to, ctx.now],
  );
  if (done.rows.length === 0) return [];
  const deltas = new Map<
    string,
    { location_id: string; variant_id: string; batch_id: string; qty: bigint }
  >();
  for (const r of done.rows) {
    const key = `${r.location_id}|${r.variant_id}|${r.batch_id}`;
    const d = deltas.get(key) ?? {
      location_id: r.location_id,
      variant_id: r.variant_id,
      batch_id: r.batch_id,
      qty: 0n,
    };
    d.qty += toQty4(r.qty);
    deltas.set(key, d);
  }
  const input = JSON.stringify(
    [...deltas.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, d]) => ({ ...d, qty: fromQty4(d.qty) })),
  );
  // Lock in key order first (UPDATE ... FROM has no defined order), then apply.
  const locked = await tx.query(
    `select 1 from inventory.stock_balances s
     join jsonb_to_recordset($2::jsonb) as d(location_id uuid, variant_id uuid, batch_id uuid, qty numeric)
       on s.location_id = d.location_id and s.variant_id = d.variant_id and s.batch_id = d.batch_id
     where s.tenant_id = $1 order by s.location_id, s.variant_id, s.batch_id for update of s`,
    [tenantId, input],
  );
  // reserve() always creates the balance row it holds against.
  /* v8 ignore next */
  if (locked.rows.length !== deltas.size) throw new Error("internal: reserved balance row missing");
  await tx.query(
    `update inventory.stock_balances s set reserved = s.reserved - d.qty, version = s.version + 1, updated_at = $3
     from jsonb_to_recordset($2::jsonb) as d(location_id uuid, variant_id uuid, batch_id uuid, qty numeric)
     where s.tenant_id = $1 and s.location_id = d.location_id and s.variant_id = d.variant_id
       and s.batch_id = d.batch_id`,
    [tenantId, input, ctx.now],
  );
  return done.rows
    .map((x) => ({
      locationId: x.location_id,
      variantId: x.variant_id,
      batchId: x.batch_id,
      qty: normQty(x.qty),
      line: x.source_line,
    }))
    .sort((a, b) => a.line - b.line || (a.batchId < b.batchId ? -1 : 1));
}

export async function releaseReservations(
  tx: TxHandle,
  ctx: CommandContext,
  source: { readonly type: string; readonly id: string },
): Promise<number> {
  return (await settle(tx, ctx, source, "released")).length;
}

/** Turns a document's open holds into sale movements (one per held line), in the same transaction. */
export async function commitReservations(
  tx: TxHandle,
  ctx: CommandContext,
  source: Source,
  opts: { readonly sellExpired?: boolean } = {},
): Promise<RecordResult> {
  const lines = await settle(tx, ctx, source, "committed");
  const perLine = new Map<number, number>();
  return recordMovements(
    tx,
    ctx,
    source,
    lines.map((l) => {
      const k = perLine.get(l.line) ?? 0;
      perLine.set(l.line, k + 1);
      /* v8 ignore next */
      if (k >= 1000) throw new DomainError("VALIDATION_FAILED", "Too many batches on one line.");
      return {
        locationId: l.locationId,
        variantId: l.variantId,
        batchId: l.batchId === NO_BATCH ? null : l.batchId,
        qty: fromQty4(-toQty4(l.qty)),
        reason: "sale" as const,
        // Several batches can hold one document line: number them so each movement stays unique per source.
        sourceLine: l.line * 1000 + k,
      };
    }),
    opts,
  );
}
