import { DomainError } from "@wise-biz/errors";

import { expectedAtClose, valueMinor, varianceOf } from "../domain/count.ts";
import {
  assertGapTransition,
  assertResolution,
  isGapCase,
  type GapStatus,
  type ResolutionCode,
} from "../domain/gap.ts";
import { fromQty4, NO_BATCH, normQty, toQty4 } from "../domain/qty.ts";
import { GapDetectedV1, GapResolvedV1, GapUpdatedV1 } from "../events.ts";
import { GAP_EVIDENCE_SOURCES, GAP_LEDGER_REASONS, recordMovements } from "../port.ts";

import { inventoryEvent, invalid, iso, notFound, one } from "./shared.ts";

import type { GapEvidenceItem, GapEvidencePorts, MovementInput } from "../port.ts";
import type {
  CreateGapTaskSchema,
  GapListQuerySchema,
  GenerateGapsSchema,
  ResolveGapSchema,
  UpdateGapSchema,
  UpdateGapTaskSchema,
} from "../schemas.ts";
import type { LocationExists } from "./stock.ts";
import type { TxHandle, OutboxEvent } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";
import type { z } from "zod";

export type GenerateGapsInput = z.output<typeof GenerateGapsSchema>;
export type UpdateGapInput = z.output<typeof UpdateGapSchema>;
export type CreateGapTaskInput = z.output<typeof CreateGapTaskSchema>;
export type UpdateGapTaskInput = z.output<typeof UpdateGapTaskSchema>;
export type ResolveGapInput = z.output<typeof ResolveGapSchema>;
export type GapListQuery = z.output<typeof GapListQuerySchema>;

// --- Rows and views ---

interface GapRow {
  id: string;
  count_id: string;
  location_id: string;
  variant_id: string;
  batch_id: string;
  currency: string;
  variance_qty: string;
  unit_cost_minor: string | null;
  value_minor: string | null;
  window_from: Date;
  window_to: Date;
  status: GapStatus;
  assignee_id: string | null;
  resolution_code: ResolutionCode | null;
  resolution_note: string;
  found_location_id: string | null;
  found_qty: string | null;
  version: number;
  opened_at: Date;
  resolved_at: Date | null;
}
const GAP_COLS = `id, count_id, location_id, variant_id, batch_id, currency, variance_qty::text as variance_qty,
  unit_cost_minor::text as unit_cost_minor, value_minor::text as value_minor, window_from, window_to, status,
  assignee_id, resolution_code, resolution_note, found_location_id, found_qty::text as found_qty, version, opened_at,
  resolved_at`;

interface TaskRow {
  id: string;
  title: string;
  assignee_id: string | null;
  done: boolean;
  done_at: Date | null;
  created_at: Date;
}
const TASK_COLS = "id, title, assignee_id, done, done_at, created_at";

const NIL = NO_BATCH;
const batchOrNull = (b: string): string | null => (b === NIL ? null : b);
const conflict = (message: string): DomainError => new DomainError("CONFLICT", message);

export interface GapCaseView {
  id: string;
  countId: string;
  locationId: string;
  variantId: string;
  batchId: string | null;
  currency: string;
  varianceQty: string;
  unitCostMinor: number | null;
  /** Null when the line had no known cost (never 0). */
  valueMinor: number | null;
  windowFrom: string;
  windowTo: string;
  status: GapStatus;
  assigneeId: string | null;
  resolutionCode: ResolutionCode | null;
  resolutionNote: string;
  foundLocationId: string | null;
  foundQty: string | null;
  version: number;
  taskCount: number;
  openTaskCount: number;
  openedAt: string;
  resolvedAt: string | null;
}

export interface GapTaskView {
  id: string;
  title: string;
  assigneeId: string | null;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
}

export interface GapEvidenceItemView {
  source: string;
  kind: string;
  locationId: string;
  variantId: string | null;
  occurredAt: string;
  qty: string | null;
  actorId: string | null;
  ref: string;
}

export interface GapEvidenceView {
  items: GapEvidenceItemView[];
  truncated: boolean;
  unavailable: string[];
}

const toView = (r: GapRow, taskCount: number, openTaskCount: number): GapCaseView => ({
  id: r.id,
  countId: r.count_id,
  locationId: r.location_id,
  variantId: r.variant_id,
  batchId: batchOrNull(r.batch_id),
  currency: r.currency,
  varianceQty: normQty(r.variance_qty),
  unitCostMinor: r.unit_cost_minor === null ? null : Number(r.unit_cost_minor),
  valueMinor: r.value_minor === null ? null : Number(r.value_minor),
  windowFrom: r.window_from.toISOString(),
  windowTo: r.window_to.toISOString(),
  status: r.status,
  assigneeId: r.assignee_id,
  resolutionCode: r.resolution_code,
  resolutionNote: r.resolution_note,
  foundLocationId: r.found_location_id,
  foundQty: r.found_qty === null ? null : normQty(r.found_qty),
  version: r.version,
  taskCount,
  openTaskCount,
  openedAt: r.opened_at.toISOString(),
  resolvedAt: iso(r.resolved_at),
});

const toTask = (t: TaskRow): GapTaskView => ({
  id: t.id,
  title: t.title,
  assigneeId: t.assignee_id,
  done: t.done,
  doneAt: iso(t.done_at),
  createdAt: t.created_at.toISOString(),
});

/** Headers plus task counts for many cases in one grouped query (no per-case round trip). */
async function summaries(
  tx: TxHandle,
  tenantId: string,
  rows: readonly GapRow[],
): Promise<GapCaseView[]> {
  if (rows.length === 0) return [];
  const t = await tx.query<{ case_id: string; tasks: string; open: string }>(
    `select case_id, count(*)::text as tasks, count(*) filter (where not done)::text as open
       from inventory.gap_tasks where tenant_id = $1 and case_id = any($2::uuid[]) group by case_id`,
    [tenantId, rows.map((r) => r.id)],
  );
  const byId = new Map(t.rows.map((x) => [x.case_id, x]));
  return rows.map((r) => {
    const x = byId.get(r.id);
    return toView(r, Number(x?.tasks ?? 0), Number(x?.open ?? 0));
  });
}

async function summary(tx: TxHandle, tenantId: string, r: GapRow): Promise<GapCaseView> {
  const [one] = await summaries(tx, tenantId, [r]);
  /* v8 ignore next */
  if (one === undefined) throw new Error("internal: gap summary");
  return one;
}

async function loadCase(
  tx: TxHandle,
  tenantId: string,
  id: string,
  lock: "none" | "update",
): Promise<GapRow> {
  const r = await tx.query<GapRow>(
    `select ${GAP_COLS} from inventory.gap_cases where tenant_id = $1 and id = $2${lock === "update" ? " for update" : ""}`,
    [tenantId, id],
  );
  const row = r.rows[0];
  if (row === undefined) return notFound();
  return row;
}

function requireVersion(current: number, sent: number): void {
  if (current !== sent) {
    throw conflict("Someone else changed this. Reload and try again.");
  }
}

/** A resolved case is terminal: no edit, task, or second resolution. */
function assertOpen(row: GapRow): void {
  if (row.status === "resolved") throw conflict("A resolved gap case cannot change.");
}

const gapAudit = (action: string, id: string, before: unknown, after: unknown) => ({
  action,
  entity: "inventory.gap_case",
  entityId: id,
  before,
  after,
});

const caseEvent = (
  def: Parameters<typeof inventoryEvent>[0],
  ctx: CommandContext,
  row: GapRow,
  data: unknown,
) =>
  // The variant is the ordering key (events.md): a case's events and its movements stay in order per SKU.
  inventoryEvent(def, ctx, `gap/${row.id}`, data, row.variant_id);

// --- Reads ---

export interface GapListPage {
  items: GapCaseView[];
  nextCursor: string | null;
}

export async function listGapCases(
  tx: TxHandle,
  tenantId: string,
  q: GapListQuery,
): Promise<GapListPage> {
  const limit = q.limit ?? 25;
  const params: unknown[] = [tenantId, limit + 1];
  const where = ["tenant_id = $1"];
  if (q.status !== undefined) {
    params.push(q.status);
    where.push(`status = $${String(params.length)}`);
  }
  if (q.assigneeId !== undefined) {
    params.push(q.assigneeId);
    where.push(`assignee_id = $${String(params.length)}`);
  }
  if (q.after !== undefined) {
    params.push(q.after);
    where.push(`id < $${String(params.length)}`);
  }
  const r = await tx.query<GapRow>(
    `select ${GAP_COLS} from inventory.gap_cases where ${where.join(" and ")} order by id desc limit $2`,
    params,
  );
  const page = r.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await summaries(tx, tenantId, page),
    nextCursor: r.rows.length > limit && last !== undefined ? last.id : null,
  };
}

/**
 * Evidence correlated to one case: the inventory ledger of its variant at its location inside the count window
 * (adjustments, write-offs, expiry, transfers, returns), plus each sales-owned source that is wired. Bounded: at most
 * 200 events, newest first. A source that is not wired is listed in `unavailable`, never shown as zero events.
 */
const EVIDENCE_LIMIT = 200;

export async function gapEvidence(
  tx: TxHandle,
  tenantId: string,
  row: GapRow,
  ports: GapEvidencePorts,
): Promise<GapEvidenceView> {
  const ledger = await tx.query<{
    occurred_at: Date;
    reason: string;
    qty: string;
    source_type: string;
    source_id: string;
  }>(
    `select occurred_at, reason, qty::text as qty, source_type, source_id
       from inventory.stock_movements
      where tenant_id = $1 and variant_id = $2 and location_id = $3
        and occurred_at between $4 and $5 and reason = any($6::text[])
      order by occurred_at desc, id desc
      limit $7`,
    [
      tenantId,
      row.variant_id,
      row.location_id,
      row.window_from,
      row.window_to,
      GAP_LEDGER_REASONS,
      EVIDENCE_LIMIT + 1,
    ],
  );
  const q = {
    locationId: row.location_id,
    variantIds: [row.variant_id],
    from: row.window_from,
    to: row.window_to,
  };
  const wired = GAP_EVIDENCE_SOURCES.flatMap((name) => {
    const fn = ports[name];
    return fn === undefined ? [] : [{ name, fn }];
  });
  const unavailable = GAP_EVIDENCE_SOURCES.filter((name) => ports[name] === undefined);
  const fromPorts = await Promise.all(wired.map(({ fn }) => fn(tx, tenantId, q)));

  const from = row.window_from.getTime();
  const to = row.window_to.getTime();
  const inWindow = (e: GapEvidenceItem): boolean =>
    e.locationId === row.location_id &&
    (e.variantId === null || e.variantId === row.variant_id) &&
    e.occurredAt.getTime() >= from &&
    e.occurredAt.getTime() <= to;
  const items: GapEvidenceItemView[] = [
    ...ledger.rows.map((r) => ({
      source: "inventory.ledger",
      kind: r.reason,
      locationId: row.location_id,
      variantId: row.variant_id,
      occurredAt: r.occurred_at.toISOString(),
      qty: normQty(r.qty),
      actorId: null,
      ref: `${r.source_type}/${r.source_id}`,
    })),
    ...fromPorts.flatMap((list, i) =>
      list.filter(inWindow).map((e) => ({
        source: wired[i]?.name ?? "unknown",
        kind: e.kind,
        locationId: e.locationId,
        variantId: e.variantId,
        occurredAt: e.occurredAt.toISOString(),
        qty: e.qty,
        actorId: e.actorId,
        ref: e.ref,
      })),
    ),
  ].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
  return {
    items: items.slice(0, EVIDENCE_LIMIT),
    truncated: items.length > EVIDENCE_LIMIT,
    unavailable,
  };
}

export interface GapDetail {
  case: GapCaseView;
  tasks: GapTaskView[];
  evidence: GapEvidenceView;
}

export async function getGapCase(
  tx: TxHandle,
  tenantId: string,
  id: string,
  ports: GapEvidencePorts,
): Promise<GapDetail> {
  const row = await loadCase(tx, tenantId, id, "none");
  const tasks = await tx.query<TaskRow>(
    `select ${TASK_COLS} from inventory.gap_tasks where tenant_id = $1 and case_id = $2 order by id`,
    [tenantId, id],
  );
  return {
    case: await summary(tx, tenantId, row),
    tasks: tasks.rows.map(toTask),
    evidence: await gapEvidence(tx, tenantId, row, ports),
  };
}

// --- Generate cases from an approved count ---

interface CountHead {
  id: string;
  location_id: string;
  mode: "frozen" | "live";
  currency: string;
  status: string;
  opened_at: Date;
  closed_at: Date | null;
}

/**
 * One case per approved count line over the thresholds (variance = counted minus expected at the count's cut, the same
 * value approval posted). Idempotent per count line: the unique key on (count, variant, batch) makes a replay insert
 * nothing, so a replay returns created 0 and no events.
 */
export async function generateGapCasesCommand(
  tx: TxHandle,
  ctx: CommandContext,
  countId: string,
  b: GenerateGapsInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const head = await tx.query<CountHead>(
    `select id, location_id, mode, currency, status, opened_at, closed_at from inventory.stock_counts
      where tenant_id = $1 and id = $2 for share`,
    [tenantId, countId],
  );
  const c = head.rows[0];
  if (c === undefined) return notFound();
  if (c.status !== "approved") {
    throw conflict("Gap cases come from an approved count. Approve the count first.");
  }
  const lines = await tx.query<{
    variant_id: string;
    batch_id: string;
    expected_qty: string;
    close_qty: string | null;
    counted_qty: string | null;
    unit_cost_minor: string | null;
  }>(
    `select variant_id, batch_id, expected_qty::text as expected_qty, close_qty::text as close_qty,
        counted_qty::text as counted_qty, unit_cost_minor::text as unit_cost_minor
       from inventory.count_lines where tenant_id = $1 and count_id = $2`,
    [tenantId, countId],
  );
  const thresholds = {
    minQty4: b.minQty === undefined ? undefined : toQty4(b.minQty),
    minValueMinor: b.minValueMinor,
  };
  const cases: {
    id: string;
    variant_id: string;
    batch_id: string;
    variance_qty: string;
    unit_cost_minor: number | null;
    value_minor: number | null;
  }[] = [];
  const found = new Map<
    string,
    { id: string; variantId: string; batchId: string; variance: string; value: number | null }
  >();
  for (const l of lines.rows) {
    const counted = toQty4(l.counted_qty ?? "0");
    const expected = expectedAtClose(c.mode, toQty4(l.expected_qty), toQty4(l.close_qty ?? "0"));
    const variance = varianceOf(counted, expected);
    const cost = l.unit_cost_minor === null ? null : Number(l.unit_cost_minor);
    const value = valueMinor(variance, cost, c.currency);
    if (!isGapCase(variance, value, thresholds)) continue;
    cases.push({
      id: ctx.ids.uuidv7(),
      variant_id: l.variant_id,
      batch_id: l.batch_id,
      variance_qty: fromQty4(variance),
      unit_cost_minor: cost,
      value_minor: value,
    });
  }
  const inserted = await tx.query<{
    id: string;
    variant_id: string;
    batch_id: string;
    variance_qty: string;
    value_minor: string | null;
  }>(
    `insert into inventory.gap_cases (tenant_id, id, count_id, location_id, variant_id, batch_id, currency, variance_qty,
        unit_cost_minor, value_minor, window_from, window_to, status, version, opened_by, opened_at, created_at, updated_at)
     select $1, x.id, $2, $3, x.variant_id, x.batch_id, $4, x.variance_qty, x.unit_cost_minor, x.value_minor, $5, $6,
        'open', 1, $7, $8, $8, $8
       from jsonb_to_recordset($9::jsonb) as x(id uuid, variant_id uuid, batch_id uuid, variance_qty numeric,
         unit_cost_minor bigint, value_minor bigint)
     on conflict (tenant_id, count_id, variant_id, batch_id) do nothing
     returning id, variant_id, batch_id, variance_qty::text as variance_qty, value_minor::text as value_minor`,
    [
      tenantId,
      countId,
      c.location_id,
      c.currency,
      c.opened_at,
      c.closed_at,
      ctx.userId,
      ctx.now,
      JSON.stringify(cases),
    ],
  );
  for (const r of inserted.rows) {
    found.set(r.id, {
      id: r.id,
      variantId: r.variant_id,
      batchId: r.batch_id,
      variance: r.variance_qty,
      value: r.value_minor === null ? null : Number(r.value_minor),
    });
  }
  const events: OutboxEvent[] = [...found.values()].map((g) =>
    inventoryEvent(
      GapDetectedV1,
      ctx,
      `gap/${g.id}`,
      {
        caseId: g.id,
        countId,
        locationId: c.location_id,
        variantId: g.variantId,
        batchId: batchOrNull(g.batchId),
        varianceQty: normQty(g.variance),
        valueMinor: g.value,
        currency: c.currency,
      },
      g.variantId,
    ),
  );
  const created = found.size;
  const body = { countId, created, existing: cases.length - created };
  return {
    status: 201,
    body,
    audit: [
      {
        action: "inventory.gap.detected",
        entity: "inventory.count",
        entityId: countId,
        before: undefined,
        after: body,
      },
    ],
    ...(events.length === 0 ? { noEvents: true } : { events }),
  };
}

// --- Status, assignee, tasks ---

/** Status (open -> investigating) and assignee. A change that changes nothing is refused rather than audited. */
export async function updateGapCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: UpdateGapInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadCase(tx, tenantId, id, "update");
  requireVersion(row.version, b.version);
  assertOpen(row);
  const next: GapStatus = b.status ?? row.status;
  const changes: ("status" | "assignee")[] = [];
  if (next !== row.status) {
    assertGapTransition(row.status, next);
    changes.push("status");
  }
  const assignee = b.assigneeId === undefined ? row.assignee_id : b.assigneeId;
  if (assignee !== row.assignee_id) changes.push("assignee");
  if (changes.length === 0) throw conflict("Nothing changes.");
  await tx.query(
    `update inventory.gap_cases set status = $3, assignee_id = $4, version = version + 1, updated_at = $5
      where tenant_id = $1 and id = $2`,
    [tenantId, id, next, assignee, ctx.now],
  );
  const after = await loadCase(tx, tenantId, id, "none");
  return {
    status: 200,
    body: await summary(tx, tenantId, after),
    audit: [
      gapAudit(
        "inventory.gap.updated",
        id,
        { status: row.status, assigneeId: row.assignee_id },
        { status: next, assigneeId: assignee, changes },
      ),
    ],
    events: [
      caseEvent(GapUpdatedV1, ctx, row, {
        caseId: id,
        locationId: row.location_id,
        variantId: row.variant_id,
        status: next,
        changes,
      }),
    ],
  };
}

export async function addGapTaskCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: CreateGapTaskInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadCase(tx, tenantId, id, "update");
  requireVersion(row.version, b.version);
  assertOpen(row);
  const taskId = ctx.ids.uuidv7();
  await tx.query(
    `insert into inventory.gap_tasks (tenant_id, id, case_id, title, assignee_id, done, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, false, $6, $7, $7)`,
    [tenantId, taskId, id, b.title, b.assigneeId ?? null, ctx.userId, ctx.now],
  );
  await tx.query(
    `update inventory.gap_cases set version = version + 1, updated_at = $3 where tenant_id = $1 and id = $2`,
    [tenantId, id, ctx.now],
  );
  const task = await tx.query<TaskRow>(
    `select ${TASK_COLS} from inventory.gap_tasks where tenant_id = $1 and id = $2`,
    [tenantId, taskId],
  );
  const after = await loadCase(tx, tenantId, id, "none");
  return {
    status: 201,
    body: { task: toTask(one(task.rows)), case: await summary(tx, tenantId, after) },
    audit: [gapAudit("inventory.gap.task_added", id, undefined, { taskId, title: b.title })],
    events: [
      caseEvent(GapUpdatedV1, ctx, row, {
        caseId: id,
        locationId: row.location_id,
        variantId: row.variant_id,
        status: row.status,
        changes: ["task_added"],
      }),
    ],
  };
}

export async function updateGapTaskCommand(
  tx: TxHandle,
  ctx: CommandContext,
  caseId: string,
  taskId: string,
  b: UpdateGapTaskInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadCase(tx, tenantId, caseId, "update");
  requireVersion(row.version, b.version);
  assertOpen(row);
  const t = await tx.query<TaskRow>(
    `select ${TASK_COLS} from inventory.gap_tasks where tenant_id = $1 and case_id = $2 and id = $3 for update`,
    [tenantId, caseId, taskId],
  );
  const task = t.rows[0];
  if (task === undefined) return notFound();
  const done = b.done ?? task.done;
  const assignee = b.assigneeId === undefined ? task.assignee_id : b.assigneeId;
  if (done === task.done && assignee === task.assignee_id) throw conflict("Nothing changes.");
  await tx.query(
    `update inventory.gap_tasks set assignee_id = $3, done = $4, done_by = $5, done_at = $6, updated_at = $7
      where tenant_id = $1 and id = $2`,
    [tenantId, taskId, assignee, done, done ? ctx.userId : null, done ? ctx.now : null, ctx.now],
  );
  await tx.query(
    `update inventory.gap_cases set version = version + 1, updated_at = $3 where tenant_id = $1 and id = $2`,
    [tenantId, caseId, ctx.now],
  );
  const updated = await tx.query<TaskRow>(
    `select ${TASK_COLS} from inventory.gap_tasks where tenant_id = $1 and id = $2`,
    [tenantId, taskId],
  );
  const after = await loadCase(tx, tenantId, caseId, "none");
  return {
    status: 200,
    body: { task: toTask(one(updated.rows)), case: await summary(tx, tenantId, after) },
    audit: [
      gapAudit(
        "inventory.gap.task_updated",
        caseId,
        { taskId, done: task.done, assigneeId: task.assignee_id },
        { taskId, done, assigneeId: assignee },
      ),
    ],
    events: [
      caseEvent(GapUpdatedV1, ctx, row, {
        caseId,
        locationId: row.location_id,
        variantId: row.variant_id,
        status: row.status,
        changes: ["task_updated"],
      }),
    ],
  };
}

// --- Resolution ---

/**
 * Resolves a case once (resolved is terminal, so a second resolution is a 409 under the row lock: the only guard
 * against posting a found quantity twice). Misplaced-found posts the found quantity at the location where it was found,
 * through the inventory ledger, in this transaction; the variance booked at approval stays as it was. Every other code
 * records the decision only.
 */
export async function resolveGapCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  b: ResolveGapInput,
  locationExists: LocationExists,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const row = await loadCase(tx, tenantId, id, "update");
  requireVersion(row.version, b.version);
  assertGapTransition(row.status, "resolved");
  const variance4 = toQty4(row.variance_qty);
  const found4 = b.foundQty === undefined ? null : toQty4(b.foundQty);
  assertResolution(b.code, variance4, found4);

  let stockEvents: readonly OutboxEvent[] = [];
  if (b.code === "misplaced_found") {
    const foundAt = b.foundLocationId;
    if (foundAt === undefined || foundAt === row.location_id) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "The stock must be found at another location than the count's.",
        {
          fieldErrors: [{ path: "foundLocationId", message: "Another location than the count's." }],
        },
      );
    }
    if (!(await locationExists(tx, tenantId, foundAt))) {
      invalid("foundLocationId", "Unknown location.");
    }
    const movement: MovementInput = {
      locationId: foundAt,
      variantId: row.variant_id,
      batchId: batchOrNull(row.batch_id),
      qty: fromQty4(found4 ?? 0n),
      reason: "adjust",
      sourceLine: 1,
      unitCostMinor: row.unit_cost_minor === null ? null : Number(row.unit_cost_minor),
    };
    const stock = await recordMovements(tx, ctx, { type: "gap_case", id, occurredAt: ctx.now }, [
      movement,
    ]);
    stockEvents = stock.events;
  }

  const foundLocationId = b.code === "misplaced_found" ? (b.foundLocationId ?? null) : null;
  const foundQty = b.code === "misplaced_found" ? (b.foundQty ?? null) : null;
  await tx.query(
    `update inventory.gap_cases set status = 'resolved', resolution_code = $3, resolution_note = $4,
        found_location_id = $5, found_qty = $6, resolved_by = $7, resolved_at = $8, version = version + 1, updated_at = $8
      where tenant_id = $1 and id = $2`,
    [tenantId, id, b.code, b.note ?? "", foundLocationId, foundQty, ctx.userId, ctx.now],
  );
  const after = await loadCase(tx, tenantId, id, "none");
  return {
    status: 200,
    body: await summary(tx, tenantId, after),
    audit: [
      gapAudit(
        "inventory.gap.resolved",
        id,
        { status: row.status },
        {
          status: "resolved",
          resolutionCode: b.code,
          foundLocationId,
          foundQty,
          stockMoved: stockEvents.length > 0,
        },
      ),
    ],
    events: [
      caseEvent(GapResolvedV1, ctx, row, {
        caseId: id,
        countId: row.count_id,
        locationId: row.location_id,
        variantId: row.variant_id,
        resolutionCode: b.code,
        foundLocationId,
        foundQty,
      }),
      ...stockEvents,
    ],
  };
}
