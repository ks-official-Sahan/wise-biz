import { DomainError } from "@wise-biz/errors";

import {
  assertApprovable,
  assertCountTransition,
  expectedAtClose,
  MAX_COUNT_LINES,
  valueMinor,
  varianceOf,
  type CountMode,
  type CountStatus,
} from "../domain/count.ts";
import { fromQty4, NO_BATCH, normQty, toQty4 } from "../domain/qty.ts";
import {
  CountApprovedV1,
  CountCancelledV1,
  CountClosedV1,
  CountCreatedV1,
  CountRecountRequestedV1,
  CountStartedV1,
} from "../events.ts";
import { recordMovements } from "../port.ts";

import { inventoryEvent, invalid, iso, notFound, stale } from "./shared.ts";

import type { MovementInput } from "../port.ts";
import type { CreateCountSchema, RecountSchema, ScansSchema } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

/** Tenancy owns locations; the composition root answers in the caller's tenant transaction (RLS applies). */
export type CountLocationExists = (
  tx: TxHandle,
  tenantId: string,
  locationId: string,
) => Promise<boolean>;

export type CreateCountInput = z.output<typeof CreateCountSchema>;
export type ScansInput = z.output<typeof ScansSchema>;
export type RecountInput = z.output<typeof RecountSchema>;

// --- Rows and projections ---

interface CountRow {
  id: string;
  location_id: string;
  kind: "full" | "cycle";
  scope_category_ids: string[];
  scope_variant_ids: string[];
  blind: boolean;
  mode: CountMode;
  status: CountStatus;
  currency: string;
  note: string;
  version: number;
  opened_at: Date;
  started_at: Date | null;
  closed_at: Date | null;
  approved_at: Date | null;
  cancelled_at: Date | null;
}
const COUNT_COLS = `id, location_id, kind, scope_category_ids::text[] as scope_category_ids,
  scope_variant_ids::text[] as scope_variant_ids, blind, mode, status, currency, note, version, opened_at,
  started_at, closed_at, approved_at, cancelled_at`;

/** Nil UUID = no batch (the stock_balances and count_lines convention). */
const NIL = NO_BATCH;
const batchOrNull = (b: string): string | null => (b === NIL ? null : b);

interface LineRow {
  variant_id: string;
  batch_id: string;
  expected_qty: string;
  close_qty: string | null;
  counted_qty: string | null;
  round: number;
  recount_requested: boolean;
  unit_cost_minor: string | null;
  note: string;
}
const LINE_COLS = `variant_id, batch_id, expected_qty::text as expected_qty, close_qty::text as close_qty,
  counted_qty::text as counted_qty, round, recount_requested, unit_cost_minor::text as unit_cost_minor, note`;

export interface CountHeader {
  id: string;
  locationId: string;
  kind: "full" | "cycle";
  scope: { categoryIds: string[]; variantCount: number };
  blind: boolean;
  mode: CountMode;
  status: CountStatus;
  currency: string;
  note: string;
  version: number;
  lineCount: number;
  countedLineCount: number;
  openedAt: string;
  startedAt: string | null;
  closedAt: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
}

const toHeader = (r: CountRow, lineCount: number, countedLineCount: number): CountHeader => ({
  id: r.id,
  locationId: r.location_id,
  kind: r.kind,
  scope: { categoryIds: [...r.scope_category_ids], variantCount: r.scope_variant_ids.length },
  blind: r.blind,
  mode: r.mode,
  status: r.status,
  currency: r.currency,
  note: r.note,
  version: r.version,
  lineCount,
  countedLineCount,
  openedAt: r.opened_at.toISOString(),
  startedAt: iso(r.started_at),
  closedAt: iso(r.closed_at),
  approvedAt: iso(r.approved_at),
  cancelledAt: iso(r.cancelled_at),
});

/** Headers plus line counts for many counts in one grouped query (no per-count round trip). */
async function summaries(
  tx: TxHandle,
  tenantId: string,
  rows: readonly CountRow[],
): Promise<CountHeader[]> {
  if (rows.length === 0) return [];
  const c = await tx.query<{ count_id: string; lines: string; counted: string }>(
    `select count_id, count(*)::text as lines, count(counted_qty)::text as counted
       from inventory.count_lines where tenant_id = $1 and count_id = any($2::uuid[]) group by count_id`,
    [tenantId, rows.map((r) => r.id)],
  );
  const byId = new Map(c.rows.map((x) => [x.count_id, x]));
  return rows.map((r) => {
    const x = byId.get(r.id);
    return toHeader(r, Number(x?.lines ?? 0), Number(x?.counted ?? 0));
  });
}

/** Header plus line counts of one count. */
async function summary(tx: TxHandle, tenantId: string, r: CountRow): Promise<CountHeader> {
  const [one] = await summaries(tx, tenantId, [r]);
  /* v8 ignore next */
  if (one === undefined) throw new Error("internal: summary");
  return one;
}

async function loadHeader(
  tx: TxHandle,
  tenantId: string,
  id: string,
  lock: "none" | "share" | "update",
): Promise<CountRow> {
  const lockSql = lock === "none" ? "" : lock === "share" ? " for share" : " for update";
  const r = await tx.query<CountRow>(
    `select ${COUNT_COLS} from inventory.stock_counts where tenant_id = $1 and id = $2${lockSql}`,
    [tenantId, id],
  );
  const row = r.rows[0];
  if (row === undefined) return notFound();
  return row;
}

async function loadLines(tx: TxHandle, tenantId: string, countId: string): Promise<LineRow[]> {
  const r = await tx.query<LineRow>(
    `select ${LINE_COLS} from inventory.count_lines where tenant_id = $1 and count_id = $2
      order by variant_id, batch_id`,
    [tenantId, countId],
  );
  return r.rows;
}

const conflict = (message: string): DomainError => new DomainError("CONFLICT", message);

function requireVersion(current: number, sent: number): void {
  if (current !== sent) stale();
}

const countEvent = (
  def: Parameters<typeof inventoryEvent>[0],
  ctx: CommandContext,
  countId: string,
  data: unknown,
) =>
  // The count id is the ordering key: one count's events reach consumers in order.
  inventoryEvent(def, ctx, `count/${countId}`, data, countId);

const audit = (action: string, id: string, before: unknown, after: unknown) => ({
  action,
  entity: "inventory.count",
  entityId: id,
  before,
  after,
});

// --- Create (snapshot) ---

/**
 * Creates a draft count and takes the snapshot: one statement copies the balance projection at the location into
 * lines (expected). Cycle counts resolve their variant set from categories and explicit variants first; untracked
 * variants with no stock there get a zero line so their scans are in scope.
 */
export async function createCountCommand(
  tx: TxHandle,
  ctx: CommandContext,
  b: CreateCountInput,
  locationExists: CountLocationExists,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  if (!(await locationExists(tx, tenantId, b.locationId)))
    invalid("locationId", "Unknown location.");
  const categoryIds = b.scope?.categoryIds ?? [];
  const variantIds = [...new Set(b.scope?.variantIds ?? [])];
  const isFull = b.kind === "full";
  let scopeVariants: string[] = [];
  if (!isFull) {
    const r = await tx.query<{ variant_id: string }>(
      `select variant_id from inventory.variant_facts
        where tenant_id = $1 and archived = false
          and (variant_id = any($2::uuid[]) or category_ids && $3::uuid[])`,
      [tenantId, variantIds, categoryIds],
    );
    const known = new Set(r.rows.map((x) => x.variant_id));
    variantIds.forEach((v, i) => {
      if (!known.has(v)) invalid(`scope.variantIds.${String(i)}`, "Unknown or archived variant.");
    });
    scopeVariants = [...known];
    if (scopeVariants.length === 0) invalid("scope", "No variant in this scope.");
  }
  const id = b.id ?? ctx.ids.uuidv7();
  await tx.query(
    `insert into inventory.stock_counts (tenant_id, id, location_id, kind, scope_category_ids, scope_variant_ids,
       blind, mode, status, currency, note, opened_by, opened_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7, $8, 'draft', $9, $10, $11, $12, $12, $12)`,
    [
      tenantId,
      id,
      b.locationId,
      b.kind,
      categoryIds,
      variantIds,
      b.blind,
      b.mode,
      b.currency,
      b.note ?? "",
      ctx.userId,
      ctx.now,
    ],
  );
  // One statement: the snapshot cut of the projection. Full counts take every row at the location; cycle counts take
  // the rows of the scoped variants.
  await tx.query(
    `insert into inventory.count_lines (tenant_id, count_id, variant_id, batch_id, expected_qty)
     select $1, $2, s.variant_id, s.batch_id, s.qty from inventory.stock_balances s
      where s.tenant_id = $1 and s.location_id = $3 and ($4::boolean or s.variant_id = any($5::uuid[]))`,
    [tenantId, id, b.locationId, isFull, scopeVariants],
  );
  if (!isFull) {
    await tx.query(
      `insert into inventory.count_lines (tenant_id, count_id, variant_id, batch_id, expected_qty)
       select $1, $2, f.variant_id, $4, 0 from inventory.variant_facts f
        where f.tenant_id = $1 and f.variant_id = any($3::uuid[]) and f.tracks_batches = false
          and not exists (select 1 from inventory.count_lines l
            where l.tenant_id = $1 and l.count_id = $2 and l.variant_id = f.variant_id)`,
      [tenantId, id, scopeVariants, NIL],
    );
  }
  const lines = await tx.query<{ n: string }>(
    "select count(*)::text as n from inventory.count_lines where tenant_id = $1 and count_id = $2",
    [tenantId, id],
  );
  const lineCount = Number(lines.rows[0]?.n ?? 0);
  if (lineCount > MAX_COUNT_LINES) {
    invalid(
      "scope",
      `Too many lines for one count (max ${String(MAX_COUNT_LINES)}). Split it into cycle counts.`,
    );
  }
  const row = await loadHeader(tx, tenantId, id, "none");
  const after = await summary(tx, tenantId, row);
  return {
    status: 201,
    body: after,
    audit: [audit("inventory.count.created", id, undefined, { status: "draft", lineCount })],
    events: [
      countEvent(CountCreatedV1, ctx, id, {
        countId: id,
        locationId: b.locationId,
        kind: b.kind,
        mode: b.mode,
        blind: b.blind,
        lineCount,
      }),
    ],
  };
}

// --- Status moves ---

/** Draft -> open: counters may scan. */
export async function openCountCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  version: number,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadHeader(tx, tenantId, id, "update");
  requireVersion(row.version, version);
  assertCountTransition(row.status, "open");
  await tx.query(
    `update inventory.stock_counts set status = 'open', started_at = $3, version = version + 1, updated_at = $3
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const after = await summary(tx, tenantId, await loadHeader(tx, tenantId, id, "none"));
  return {
    status: 200,
    body: after,
    audit: [audit("inventory.count.started", id, { status: row.status }, { status: "open" })],
    events: [countEvent(CountStartedV1, ctx, id, { countId: id, locationId: row.location_id })],
  };
}

/** Cancel is allowed while the count is not yet approved. Nothing has been posted, so there is nothing to reverse. */
export async function cancelCountCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  version: number,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadHeader(tx, tenantId, id, "update");
  requireVersion(row.version, version);
  assertCountTransition(row.status, "cancelled");
  await tx.query(
    `update inventory.stock_counts set status = 'cancelled', cancelled_at = $3, version = version + 1, updated_at = $3
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const after = await summary(tx, tenantId, await loadHeader(tx, tenantId, id, "none"));
  return {
    status: 200,
    body: after,
    audit: [
      audit("inventory.count.cancelled", id, { status: row.status }, { status: "cancelled" }),
    ],
    events: [
      countEvent(CountCancelledV1, ctx, id, {
        countId: id,
        locationId: row.location_id,
        fromStatus: row.status as "draft" | "open" | "review",
      }),
    ],
  };
}

// --- Scans ---

/**
 * Device scans: insert-only, one row per scan id (a replayed scan is a no-op). The count row is locked FOR SHARE so
 * scans run concurrently with each other but never across a close (close takes FOR UPDATE).
 */
export async function scanCountCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: ScansInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadHeader(tx, tenantId, id, "share");
  if (row.status !== "open") throw conflict("Counting is not open.");

  const variantIds = [...new Set(b.scans.map((s) => s.variantId))];
  const facts = await tx.query<{ variant_id: string; tracks_batches: boolean; archived: boolean }>(
    `select variant_id, tracks_batches, archived from inventory.variant_facts
      where tenant_id = $1 and variant_id = any($2::uuid[])`,
    [tenantId, variantIds],
  );
  const fact = new Map(facts.rows.map((f) => [f.variant_id, f]));
  const batchIds = [...new Set(b.scans.flatMap((s) => (s.batchId ? [s.batchId] : [])))];
  const batches = await tx.query<{ id: string; variant_id: string }>(
    `select id, variant_id from inventory.batches where tenant_id = $1 and id = any($2::uuid[])`,
    [tenantId, batchIds],
  );
  const batchVariant = new Map(batches.rows.map((x) => [x.id, x.variant_id]));

  b.scans.forEach((s, i) => {
    const f = fact.get(s.variantId);
    if (f === undefined || f.archived) {
      return invalid(`scans.${String(i)}.variantId`, "Unknown or archived variant.");
    }
    if (f.tracks_batches && !s.batchId) {
      return invalid(
        `scans.${String(i)}.batchId`,
        "This variant is tracked by batch: scan the batch.",
      );
    }
    if (!f.tracks_batches && s.batchId) {
      return invalid(`scans.${String(i)}.batchId`, "This variant does not track batches.");
    }
    if (s.batchId && batchVariant.get(s.batchId) !== s.variantId) {
      return invalid(`scans.${String(i)}.batchId`, "Unknown batch for this variant.");
    }
  });

  // Lines of the scanned variants. A scan of a key with no line creates a found line (expected 0: a key with no
  // balance row at the snapshot cut is zero then). Cycle counts only add keys to variants already on the sheet.
  const keyOf = (v: string, bt: string) => `${v}|${bt}`;
  const scanKey = (s: ScansInput["scans"][number]) => keyOf(s.variantId, s.batchId ?? NIL);
  const onSheet = await tx.query<{ variant_id: string; batch_id: string; round: number }>(
    `select variant_id, batch_id, round from inventory.count_lines
      where tenant_id = $1 and count_id = $2 and variant_id = any($3::uuid[])`,
    [tenantId, id, variantIds],
  );
  const lines = new Map(onSheet.rows.map((l) => [keyOf(l.variant_id, l.batch_id), l]));
  const sheetVariants = new Set(onSheet.rows.map((l) => l.variant_id));
  const missing = new Map<string, { variant_id: string; batch_id: string }>();
  b.scans.forEach((s, i) => {
    const k = scanKey(s);
    if (lines.has(k) || missing.has(k)) return;
    if (row.kind === "cycle" && !sheetVariants.has(s.variantId)) {
      invalid(`scans.${String(i)}.variantId`, "Not in this cycle count's scope.");
    }
    missing.set(k, { variant_id: s.variantId, batch_id: s.batchId ?? NIL });
  });
  if (missing.size > 0) {
    await tx.query(
      `insert into inventory.count_lines (tenant_id, count_id, variant_id, batch_id, expected_qty)
       select $1, $2, x.variant_id, x.batch_id, 0
         from jsonb_to_recordset($3::jsonb) as x(variant_id uuid, batch_id uuid)
       on conflict (tenant_id, count_id, variant_id, batch_id) do nothing`,
      [tenantId, id, JSON.stringify([...missing.values()])],
    );
    const again = await tx.query<{ variant_id: string; batch_id: string; round: number }>(
      `select variant_id, batch_id, round from inventory.count_lines
        where tenant_id = $1 and count_id = $2 and variant_id = any($3::uuid[])`,
      [tenantId, id, variantIds],
    );
    for (const l of again.rows) lines.set(keyOf(l.variant_id, l.batch_id), l);
  }

  const rows = b.scans.map((s) => {
    const line = lines.get(scanKey(s));
    /* v8 ignore next */
    if (line === undefined) throw new Error("internal: scan line missing");
    return {
      id: s.id,
      variant_id: s.variantId,
      batch_id: s.batchId ?? NIL,
      round: line.round,
      qty: s.qty,
      scanned_at: s.scannedAt,
    };
  });
  const inserted = await tx.query<{ id: string }>(
    `insert into inventory.count_scans (tenant_id, id, count_id, variant_id, batch_id, round, qty, device_id, scanned_at)
     select $1, x.id, $2, x.variant_id, x.batch_id, x.round, x.qty, $3, x.scanned_at
       from jsonb_to_recordset($4::jsonb) as x(id uuid, variant_id uuid, batch_id uuid, round int, qty numeric,
         scanned_at timestamptz)
     on conflict (tenant_id, id) do nothing
     returning id`,
    [tenantId, id, b.deviceId ?? null, JSON.stringify(rows)],
  );
  const accepted = inserted.rows.length;
  return {
    status: 200,
    body: { accepted, duplicates: rows.length - accepted },
    audit: [
      audit("inventory.count.scanned", id, undefined, {
        accepted,
        duplicates: rows.length - accepted,
      }),
    ],
    noEvents: true,
  };
}

// --- Recount request ---

/**
 * Sends lines back for another count: the line gets a new round (earlier scans stay in their round), its counted
 * quantity is cleared, and a count under review goes back to open.
 */
export async function requestRecountCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: RecountInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadHeader(tx, tenantId, id, "update");
  requireVersion(row.version, b.version);
  if (row.status !== "open" && row.status !== "review") {
    throw conflict("Only a count that is open or under review can be recounted.");
  }
  const keys = b.lines.map((l) => ({ variant_id: l.variantId, batch_id: l.batchId ?? NIL }));
  if (new Set(keys.map((k) => `${k.variant_id}|${k.batch_id}`)).size !== keys.length) {
    invalid("lines", "A line is listed twice.");
  }
  const found = await tx.query<{ variant_id: string; batch_id: string }>(
    `select x.variant_id, x.batch_id from jsonb_to_recordset($3::jsonb) as x(variant_id uuid, batch_id uuid)
       join inventory.count_lines l on l.tenant_id = $1 and l.count_id = $2 and l.variant_id = x.variant_id
        and l.batch_id = x.batch_id`,
    [tenantId, id, JSON.stringify(keys)],
  );
  if (found.rows.length !== keys.length) invalid("lines", "A line is not part of this count.");
  await tx.query(
    `update inventory.count_lines l set round = l.round + 1, recount_requested = true, counted_qty = null,
        close_qty = null, unit_cost_minor = null, note = coalesce(x.note, l.note), updated_at = $4
       from jsonb_to_recordset($3::jsonb) as x(variant_id uuid, batch_id uuid, note text)
      where l.tenant_id = $1 and l.count_id = $2 and l.variant_id = x.variant_id and l.batch_id = x.batch_id`,
    [
      tenantId,
      id,
      JSON.stringify(b.lines.map((l, i) => ({ ...keys[i], note: l.note ?? null }))),
      ctx.now,
    ],
  );
  const next: CountStatus = "open";
  if (row.status === "review") assertCountTransition(row.status, next);
  await tx.query(
    `update inventory.stock_counts set status = 'open', version = version + 1, updated_at = $3
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const after = await summary(tx, tenantId, await loadHeader(tx, tenantId, id, "none"));
  const lines = keys.map((k) => ({ variantId: k.variant_id, batchId: batchOrNull(k.batch_id) }));
  return {
    status: 200,
    body: after,
    audit: [
      audit(
        "inventory.count.recount_requested",
        id,
        { status: row.status },
        { status: "open", lines },
      ),
    ],
    events: [
      countEvent(CountRecountRequestedV1, ctx, id, {
        countId: id,
        locationId: row.location_id,
        lines,
      }),
    ],
  };
}

// --- Close (second snapshot, counted quantities, valuation) ---

/** Currency of a cost is only used when it matches the count's currency; otherwise the cost is unknown. */
async function unitCostsFor(
  tx: TxHandle,
  tenantId: string,
  locationId: string,
  currency: string,
  keys: readonly { variant_id: string; batch_id: string }[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const batchIds = [...new Set(keys.filter((k) => k.batch_id !== NIL).map((k) => k.batch_id))];
  const variants = [...new Set(keys.filter((k) => k.batch_id === NIL).map((k) => k.variant_id))];
  const [b, latest, anywhere] = [
    batchIds.length === 0
      ? { rows: [] }
      : await tx.query<{ id: string; unit_cost_minor: string; currency: string }>(
          `select id, unit_cost_minor::text as unit_cost_minor, currency from inventory.batches
            where tenant_id = $1 and id = any($2::uuid[])`,
          [tenantId, batchIds],
        ),
    variants.length === 0
      ? { rows: [] }
      : await tx.query<{ variant_id: string; unit_cost_minor: string; currency: string }>(
          `select v.variant_id, lm.unit_cost_minor::text as unit_cost_minor, r.currency
             from unnest($3::uuid[]) as v(variant_id)
             cross join lateral (
               select m.unit_cost_minor, m.source_id from inventory.stock_movements m
                where m.tenant_id = $1 and m.variant_id = v.variant_id and m.location_id = $2
                  and m.reason = 'receive' and m.source_type = 'receipt'
                order by m.occurred_at desc, m.id desc limit 1) lm
             join inventory.receipts r on r.tenant_id = $1 and r.id = lm.source_id`,
          [tenantId, locationId, variants],
        ),
    variants.length === 0
      ? { rows: [] }
      : await tx.query<{ variant_id: string; unit_cost_minor: string; currency: string }>(
          `select v.variant_id, lm.unit_cost_minor::text as unit_cost_minor, r.currency
             from unnest($2::uuid[]) as v(variant_id)
             cross join lateral (
               select m.unit_cost_minor, m.source_id from inventory.stock_movements m
                where m.tenant_id = $1 and m.variant_id = v.variant_id
                  and m.reason = 'receive' and m.source_type = 'receipt'
                order by m.occurred_at desc, m.id desc limit 1) lm
             join inventory.receipts r on r.tenant_id = $1 and r.id = lm.source_id`,
          [tenantId, variants],
        ),
  ];
  const batch = new Map(b.rows.map((x) => [x.id, x]));
  const here = new Map(latest.rows.map((x) => [x.variant_id, x]));
  const elsewhere = new Map(anywhere.rows.map((x) => [x.variant_id, x]));
  for (const k of keys) {
    const hit =
      k.batch_id === NIL
        ? (here.get(k.variant_id) ?? elsewhere.get(k.variant_id))
        : batch.get(k.batch_id);
    const cost = hit?.currency === currency ? Number(hit.unit_cost_minor) : null;
    out.set(`${k.variant_id}|${k.batch_id}`, cost);
  }
  return out;
}

/**
 * Close: the counting window ends. One statement copies the balance projection (close_qty) for every line, adding
 * lines for stock that appeared since the snapshot (expected 0). Counted quantities are summed from the scans of
 * each line's current round, and uncounted lines are either left uncounted (approval refuses) or booked as zero when
 * the operator asks for it. The expectation is fixed from here on.
 */
export async function closeCountCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: { version: number; zeroUncounted?: boolean | undefined },
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadHeader(tx, tenantId, id, "update");
  requireVersion(row.version, b.version);
  assertCountTransition(row.status, "review");

  await tx.query(
    `with cut as (
       select variant_id, batch_id, qty from inventory.stock_balances
        where tenant_id = $1 and location_id = $3
     ), added as (
       insert into inventory.count_lines (tenant_id, count_id, variant_id, batch_id, expected_qty, close_qty)
       select $1, $2, c.variant_id, c.batch_id, 0, c.qty from cut c
        where ($4::boolean or exists (select 1 from inventory.count_lines l
                where l.tenant_id = $1 and l.count_id = $2 and l.variant_id = c.variant_id))
          and not exists (select 1 from inventory.count_lines l
                where l.tenant_id = $1 and l.count_id = $2 and l.variant_id = c.variant_id
                  and l.batch_id = c.batch_id)
       on conflict (tenant_id, count_id, variant_id, batch_id) do nothing
       returning 1
     )
     update inventory.count_lines l set close_qty = coalesce((select c.qty from cut c
              where c.variant_id = l.variant_id and c.batch_id = l.batch_id), 0)
      where l.tenant_id = $1 and l.count_id = $2
     returning 1`,
    [tenantId, id, row.location_id, row.kind === "full"],
  );

  // Counted = the scans of each line's current round. Scans cannot land now: the header lock above waits for them.
  await tx.query(
    `update inventory.count_lines set counted_qty = null, recount_requested = false, updated_at = $3
      where tenant_id = $1 and count_id = $2`,
    [tenantId, id, ctx.now],
  );
  await tx.query(
    `update inventory.count_lines l set counted_qty = t.qty, updated_at = $3
       from (select variant_id, batch_id, round, sum(qty) as qty from inventory.count_scans
              where tenant_id = $1 and count_id = $2 group by variant_id, batch_id, round) t
      where l.tenant_id = $1 and l.count_id = $2 and t.variant_id = l.variant_id and t.batch_id = l.batch_id
        and t.round = l.round`,
    [tenantId, id, ctx.now],
  );
  if (b.zeroUncounted === true) {
    await tx.query(
      `update inventory.count_lines set counted_qty = 0, updated_at = $3
        where tenant_id = $1 and count_id = $2 and counted_qty is null`,
      [tenantId, id, ctx.now],
    );
  }

  const lines = await loadLines(tx, tenantId, id);
  const costs = await unitCostsFor(
    tx,
    tenantId,
    row.location_id,
    row.currency,
    lines.map((l) => ({
      variant_id: l.variant_id,
      batch_id: l.batch_id,
    })),
  );
  await tx.query(
    `update inventory.count_lines l set unit_cost_minor = x.cost, updated_at = $4
       from jsonb_to_recordset($3::jsonb) as x(variant_id uuid, batch_id uuid, cost bigint)
      where l.tenant_id = $1 and l.count_id = $2 and l.variant_id = x.variant_id and l.batch_id = x.batch_id`,
    [
      tenantId,
      id,
      JSON.stringify(
        lines.map((l) => ({
          variant_id: l.variant_id,
          batch_id: l.batch_id,
          cost: costs.get(`${l.variant_id}|${l.batch_id}`) ?? null,
        })),
      ),
      ctx.now,
    ],
  );

  const uncounted = lines.filter((l) => l.counted_qty === null).length;
  await tx.query(
    `update inventory.stock_counts set status = 'review', closed_by = $3, closed_at = $4, version = version + 1,
        updated_at = $4
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.userId, ctx.now],
  );
  const after = await summary(tx, tenantId, await loadHeader(tx, tenantId, id, "none"));
  return {
    status: 200,
    body: after,
    audit: [
      audit(
        "inventory.count.closed",
        id,
        { status: row.status },
        {
          status: "review",
          lineCount: lines.length,
          uncountedLines: uncounted,
          zeroUncounted: b.zeroUncounted === true,
        },
      ),
    ],
    events: [
      countEvent(CountClosedV1, ctx, id, {
        countId: id,
        locationId: row.location_id,
        lineCount: lines.length,
        uncountedLines: uncounted,
      }),
    ],
  };
}

// --- Approve (posts the variances) ---

/**
 * Approval: the variance of each line (counted minus expected at the close cut, or the snapshot when frozen) is posted
 * as a count_variance movement through the inventory ledger, in this transaction with the audit row and the outbox.
 * After the close cut, sales keep moving stock: those movements stay on the ledger, so the balance after approval is
 * counted plus the movements made after the close.
 */
export async function approveCountCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  version: number,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadHeader(tx, tenantId, id, "update");
  requireVersion(row.version, version);
  assertCountTransition(row.status, "approved");
  const lines = await loadLines(tx, tenantId, id);
  assertApprovable(
    row.mode,
    lines.map((l) => ({
      counted4: l.counted_qty === null ? null : toQty4(l.counted_qty),
      snapshot4: toQty4(l.expected_qty),
      close4: l.close_qty === null ? null : toQty4(l.close_qty),
    })),
  );

  const movements: MovementInput[] = [];
  let netValue: number | null = 0;
  let unvalued = 0;
  let adjusted = 0;
  lines.forEach((l, i) => {
    const counted = toQty4(l.counted_qty ?? "0");
    const close = toQty4(l.close_qty ?? "0");
    const expected = expectedAtClose(row.mode, toQty4(l.expected_qty), close);
    const variance = varianceOf(counted, expected);
    if (variance === 0n) return;
    adjusted += 1;
    const cost = l.unit_cost_minor === null ? null : Number(l.unit_cost_minor);
    const value = valueMinor(variance, cost, row.currency);
    if (value === null) {
      unvalued += 1;
    } else if (netValue !== null) {
      netValue += value;
    }
    movements.push({
      locationId: row.location_id,
      variantId: l.variant_id,
      batchId: batchOrNull(l.batch_id),
      qty: fromQty4(variance),
      reason: "count_variance",
      // Unique per count: the line's position in key order (every line, so a line keeps its number).
      sourceLine: i + 1,
      unitCostMinor: cost,
    });
  });
  if (unvalued > 0) netValue = null;

  const stock = await recordMovements(
    tx,
    ctx,
    { type: "stock_count", id, occurredAt: ctx.now },
    movements,
  );
  await tx.query(
    `update inventory.stock_counts set status = 'approved', approved_by = $3, approved_at = $4, version = version + 1,
        updated_at = $4
      where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.userId, ctx.now],
  );
  const after = await summary(tx, tenantId, await loadHeader(tx, tenantId, id, "none"));
  return {
    status: 200,
    body: after,
    audit: [
      audit(
        "inventory.count.approved",
        id,
        { status: row.status },
        {
          status: "approved",
          adjustedLines: adjusted,
          netValueMinor: netValue,
          unvaluedLines: unvalued,
        },
      ),
    ],
    events: [
      countEvent(CountApprovedV1, ctx, id, {
        countId: id,
        locationId: row.location_id,
        adjustedLines: adjusted,
        netValueMinor: netValue,
        unvaluedLines: unvalued,
      }),
      ...stock.events,
    ],
  };
}

// --- Reads ---

export interface CountLineView {
  variantId: string;
  batchId: string | null;
  round: number;
  /** Quantity booked at close (null before close, or uncounted). */
  countedQty: string | null;
  recountRequested: boolean;
  note: string;
  /** Live scan total of the current round (open counts). */
  scannedQty: string | null;
  /** Hidden (null) for blind counts unless the caller may approve. */
  expectedQty: string | null;
  closeQty: string | null;
}

export interface CountListPage {
  items: CountHeader[];
  nextCursor: string | null;
}

export async function listCounts(
  tx: TxHandle,
  tenantId: string,
  q: { status?: CountStatus | undefined; after?: string | undefined; limit?: number | undefined },
): Promise<CountListPage> {
  const limit = q.limit ?? 25;
  const params: unknown[] = [tenantId, limit + 1];
  const where = ["tenant_id = $1"];
  if (q.status !== undefined) {
    params.push(q.status);
    where.push(`status = $${String(params.length)}`);
  }
  if (q.after !== undefined) {
    params.push(q.after);
    where.push(`id < $${String(params.length)}`);
  }
  const r = await tx.query<CountRow>(
    `select ${COUNT_COLS} from inventory.stock_counts where ${where.join(" and ")}
      order by id desc limit $2`,
    params,
  );
  const page = r.rows.slice(0, limit);
  const more = r.rows.length > limit;
  const counts = await summaries(tx, tenantId, page);
  const last = page[page.length - 1];
  return { items: counts, nextCursor: more && last !== undefined ? last.id : null };
}

/**
 * One count's header and a keyset page of its lines (key: variant, batch). Expected and close quantities are hidden for
 * blind counts unless the caller may approve; the live scan total is one lateral probe per line of the page.
 */
export async function getCount(
  tx: TxHandle,
  tenantId: string,
  id: string,
  q: { after?: string | undefined; limit?: number | undefined },
  canReview: boolean,
): Promise<{ count: CountHeader; lines: CountLineView[]; nextCursor: string | null }> {
  const row = await loadHeader(tx, tenantId, id, "none");
  const limit = q.limit ?? 200;
  const params: unknown[] = [tenantId, id, limit + 1];
  let cursor = "";
  if (q.after !== undefined) {
    const [v = "", b = ""] = q.after.split("|");
    params.push(v, b);
    cursor = `and (l.variant_id, l.batch_id) > ($4::uuid, $5::uuid)`;
  }
  const r = await tx.query<LineRow & { scanned: string | null }>(
    `select l.variant_id, l.batch_id, l.expected_qty::text as expected_qty, l.close_qty::text as close_qty,
        l.counted_qty::text as counted_qty, l.round, l.recount_requested, l.unit_cost_minor::text as unit_cost_minor,
        l.note, sc.scanned::text as scanned
       from inventory.count_lines l
       left join lateral (
         select sum(s.qty) as scanned from inventory.count_scans s
          where s.tenant_id = l.tenant_id and s.count_id = l.count_id and s.variant_id = l.variant_id
            and s.batch_id = l.batch_id and s.round = l.round
       ) sc on true
      where l.tenant_id = $1 and l.count_id = $2 ${cursor}
      order by l.variant_id, l.batch_id
      limit $3`,
    params,
  );
  const page = r.rows.slice(0, limit);
  const last = page[page.length - 1];
  const see = !row.blind || canReview;
  const lines: CountLineView[] = page.map((l) => ({
    variantId: l.variant_id,
    batchId: batchOrNull(l.batch_id),
    round: l.round,
    countedQty: l.counted_qty === null ? null : normQty(l.counted_qty),
    recountRequested: l.recount_requested,
    note: l.note,
    scannedQty: l.scanned === null ? null : normQty(l.scanned),
    expectedQty: see ? normQty(l.expected_qty) : null,
    closeQty: see && l.close_qty !== null ? normQty(l.close_qty) : null,
  }));
  const c = await summary(tx, tenantId, row);
  return {
    count: c,
    lines,
    nextCursor:
      r.rows.length > limit && last !== undefined ? `${last.variant_id}|${last.batch_id}` : null,
  };
}

export interface VarianceView {
  count: CountHeader;
  lines: {
    variantId: string;
    batchId: string | null;
    countedQty: string | null;
    expectedQty: string | null;
    varianceQty: string | null;
    unitCostMinor: number | null;
    valueMinor: number | null;
  }[];
  totals: { shortValueMinor: number | null; overValueMinor: number | null; unvaluedLines: number };
}

/**
 * Variance per line after close: counted minus expected (close cut when live, snapshot when frozen), valued at the
 * line's cost. Blind counts hide expected, variance and value unless the caller may approve.
 */
export async function getVariance(
  tx: TxHandle,
  tenantId: string,
  id: string,
  canReview: boolean,
): Promise<VarianceView> {
  const row = await loadHeader(tx, tenantId, id, "none");
  if (row.status !== "review" && row.status !== "approved") {
    throw conflict("Close the count to see its variances.");
  }
  const lines = await loadLines(tx, tenantId, id);
  const see = !row.blind || canReview;
  let short = 0;
  let over = 0;
  let unvalued = 0;
  const views = lines.map((l) => {
    const cost = l.unit_cost_minor === null ? null : Number(l.unit_cost_minor);
    const counted = l.counted_qty === null ? null : toQty4(l.counted_qty);
    const close = toQty4(l.close_qty ?? "0");
    const expected = expectedAtClose(row.mode, toQty4(l.expected_qty), close);
    const variance = counted === null ? null : varianceOf(counted, expected);
    const value = variance === null ? null : valueMinor(variance, cost, row.currency);
    if (see && variance !== null && variance !== 0n) {
      if (value === null) unvalued += 1;
      else if (value < 0) short += value;
      else over += value;
    }
    return {
      variantId: l.variant_id,
      batchId: batchOrNull(l.batch_id),
      countedQty: l.counted_qty === null ? null : normQty(l.counted_qty),
      expectedQty: see ? fromQty4(expected) : null,
      varianceQty: see && variance !== null ? fromQty4(variance) : null,
      unitCostMinor: see ? cost : null,
      valueMinor: see ? value : null,
    };
  });
  return {
    count: await summary(tx, tenantId, row),
    lines: views,
    totals: {
      shortValueMinor: see ? short : null,
      overValueMinor: see ? over : null,
      unvaluedLines: see ? unvalued : 0,
    },
  };
}
