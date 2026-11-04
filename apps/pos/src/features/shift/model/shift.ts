import { businessDateOf } from "../../tender/model/sale-command.ts";

import type { OutboxTx, Queryable } from "@wise-biz/sync";

export interface ShiftRow {
  readonly id: string;
  readonly openedAt: number;
  readonly businessDate: string;
  readonly currency: string;
  readonly openingFloatMinor: number;
  readonly closedAt?: number;
  readonly countedMinor?: number;
  readonly expectedMinor?: number;
}

interface Raw {
  readonly id: string;
  readonly opened_at: number;
  readonly business_date: string;
  readonly currency: string;
  readonly opening_float_minor: number;
  readonly closed_at: number | null;
  readonly counted_minor: number | null;
  readonly expected_minor: number | null;
}

const toShift = (r: Raw): ShiftRow => ({
  id: r.id,
  openedAt: r.opened_at,
  businessDate: r.business_date,
  currency: r.currency,
  openingFloatMinor: r.opening_float_minor,
  ...(r.closed_at === null ? {} : { closedAt: r.closed_at }),
  ...(r.counted_minor === null ? {} : { countedMinor: r.counted_minor }),
  ...(r.expected_minor === null ? {} : { expectedMinor: r.expected_minor }),
});

export interface ShiftDeps {
  readonly transaction: <T>(fn: (tx: OutboxTx) => Promise<T>) => Promise<T>;
  readonly now: () => number;
  readonly newId: () => string;
  readonly operatorId: string;
  /** The signed-in operator's permissions: cash leaving the drawer and closing the shift are checked here, not only in the UI. */
  readonly has: (permission: string) => boolean;
}

export const CASH_PERMISSION = "sales:cash";
export const SHIFT_PERMISSION = "sales:shift";

export type CashMovementKind = "pay_in" | "pay_out" | "float_add" | "drop";

export class ShiftError extends Error {
  override readonly name = "ShiftError";
  readonly code: "no_shift" | "bad_amount" | "reason_required" | "forbidden";
  constructor(code: ShiftError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const isMoney = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** The open shift of this terminal, if any. */
export async function currentShift(q: Queryable): Promise<ShiftRow | undefined> {
  const r = await q.get<Raw>(
    "SELECT * FROM local_shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",
  );
  return r === undefined ? undefined : toShift(r);
}

/**
 * The shift a sale belongs to, inside the sale's transaction. With no open shift one is opened with a zero float; an
 * open shift from an earlier business day is closed without a count (`auto_closed`) and a new one opened, so a sale
 * never carries yesterday's shift id. The shift screen (open with a float, close with a count) is the normal path.
 */
export async function ensureShift(
  tx: OutboxTx,
  deps: { now?: () => number; newId: () => string; operatorId: string },
  o: { completedAt: number; businessDate: string; currency: string },
): Promise<ShiftRow> {
  const open = await tx.get<Raw>(
    "SELECT * FROM local_shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1",
  );
  if (open !== undefined) {
    if (open.business_date === o.businessDate) return toShift(open);
    await tx.run("UPDATE local_shifts SET closed_at = ?, auto_closed = 1 WHERE id = ?", [
      o.completedAt,
      open.id,
    ]);
  }
  return openTx(tx, deps.newId(), deps.operatorId, o.completedAt, o.businessDate, o.currency, 0);
}

async function openTx(
  tx: OutboxTx,
  id: string,
  operatorId: string,
  at: number,
  businessDate: string,
  currency: string,
  floatMinor: number,
): Promise<ShiftRow> {
  await tx.run(
    "INSERT INTO local_shifts (id, opened_at, business_date, currency, opening_float_minor) VALUES (?, ?, ?, ?, ?)",
    [id, at, businessDate, currency, floatMinor],
  );
  await tx.enqueue("open_shift", {
    id,
    operatorId,
    businessDate,
    openedAt: new Date(at).toISOString(),
    currency,
    openingFloatMinor: floatMinor,
  });
  return { id, openedAt: at, businessDate, currency, openingFloatMinor: floatMinor };
}

/** Opens a shift with the counted float. An already open shift is returned unchanged. */
export async function openShift(
  deps: ShiftDeps,
  o: { floatMinor: number; currency: string },
): Promise<ShiftRow> {
  if (!isMoney(o.floatMinor))
    throw new ShiftError("bad_amount", "The float is not a valid amount.");
  return deps.transaction(async (tx) => {
    const open = await tx.get<Raw>("SELECT * FROM local_shifts WHERE closed_at IS NULL LIMIT 1");
    if (open !== undefined) return toShift(open);
    const at = deps.now();
    return openTx(
      tx,
      deps.newId(),
      deps.operatorId,
      at,
      businessDateOf(at),
      o.currency,
      o.floatMinor,
    );
  });
}

/** Pay in, pay out, float top-up or a drop to the safe: a reason is required and the movement is signed into the chain. */
export async function recordCashMovement(
  deps: ShiftDeps,
  o: { kind: CashMovementKind; amountMinor: number; reason: string },
): Promise<void> {
  if (!deps.has(CASH_PERMISSION))
    throw new ShiftError(
      "forbidden",
      "You need a supervisor to move cash in or out of the drawer.",
    );
  if (!isMoney(o.amountMinor) || o.amountMinor === 0)
    throw new ShiftError("bad_amount", "Enter an amount above zero.");
  const reason = o.reason.trim();
  if (reason === "") throw new ShiftError("reason_required", "Add a reason.");
  await deps.transaction(async (tx) => {
    const open = await tx.get<Raw>("SELECT * FROM local_shifts WHERE closed_at IS NULL LIMIT 1");
    if (open === undefined) throw new ShiftError("no_shift", "Open a shift first.");
    const at = deps.now();
    const id = deps.newId();
    await tx.run(
      "INSERT INTO local_cash_movements (id, shift_id, kind, amount_minor, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, open.id, o.kind, o.amountMinor, reason, at],
    );
    await tx.enqueue("cash_movement", {
      id,
      shiftId: open.id,
      operatorId: deps.operatorId,
      kind: o.kind,
      amountMinor: o.amountMinor,
      occurredAt: new Date(at).toISOString(),
      reason,
    });
  });
}

export interface ZReport {
  readonly shift: ShiftRow;
  /** Sales rung up in this shift (voids are counted separately and taken off the money). */
  readonly salesCount: number;
  /** Payable of this shift's sales minus the sales voided in this shift. */
  readonly salesMinor: number;
  readonly returnsCount: number;
  readonly returnsMinor: number;
  readonly voidedCount: number;
  /** Tender kind -> applied amount of sales minus refunds, so the report adds up to net takings. */
  readonly byTender: Readonly<Record<string, number>>;
  readonly cashSalesMinor: number;
  readonly cashRefundsMinor: number;
  readonly payInMinor: number;
  readonly payOutMinor: number;
  readonly floatAddedMinor: number;
  readonly dropsMinor: number;
  /** What the drawer should hold: float + cash sales + pay in + float added - cash refunds - pay out - drops. */
  readonly expectedCashMinor: number;
}

interface SaleBody {
  readonly payableMinor: number;
  readonly tenders: readonly { kind: string; amountMinor: number }[];
}
interface ReturnBody {
  readonly totalMinor: number;
  readonly tenders: readonly { kind: string; amountMinor: number }[];
}

/** The shift's numbers from the local ledgers: the same arithmetic the server does for its Z-report. */
export async function zReport(q: Queryable, shiftId: string): Promise<ZReport> {
  const row = await q.get<Raw>("SELECT * FROM local_shifts WHERE id = ?", [shiftId]);
  if (row === undefined) throw new ShiftError("no_shift", "That shift is not on this terminal.");
  const sales = await q.all<{ body: string }>("SELECT body FROM local_sales WHERE shift_id = ?", [
    shiftId,
  ]);
  // A void hands the money back from the drawer of the shift it happens in, whichever shift rang the sale up.
  const voids = await q.all<{ body: string }>(
    "SELECT body FROM local_sales WHERE voided_shift_id = ?",
    [shiftId],
  );
  const returns = await q.all<{ body: string }>(
    "SELECT body FROM local_returns WHERE shift_id = ?",
    [shiftId],
  );
  const moves = await q.all<{ kind: string; amount_minor: number }>(
    "SELECT kind, amount_minor FROM local_cash_movements WHERE shift_id = ?",
    [shiftId],
  );
  const byTender: Record<string, number> = {};
  let salesCount = 0;
  let salesMinor = 0;
  let voidedCount = 0;
  let cashSales = 0;
  for (const s of sales) {
    const b = JSON.parse(s.body) as SaleBody;
    salesCount++;
    salesMinor += b.payableMinor;
    for (const t of b.tenders) {
      byTender[t.kind] = (byTender[t.kind] ?? 0) + t.amountMinor;
      if (t.kind === "cash") cashSales += t.amountMinor;
    }
  }
  for (const v of voids) {
    const b = JSON.parse(v.body) as SaleBody;
    voidedCount++;
    salesMinor -= b.payableMinor;
    for (const t of b.tenders) {
      byTender[t.kind] = (byTender[t.kind] ?? 0) - t.amountMinor;
      if (t.kind === "cash") cashSales -= t.amountMinor;
    }
  }
  let returnsMinor = 0;
  let cashRefunds = 0;
  for (const r of returns) {
    const b = JSON.parse(r.body) as ReturnBody;
    returnsMinor += b.totalMinor;
    for (const t of b.tenders) {
      byTender[t.kind] = (byTender[t.kind] ?? 0) - t.amountMinor;
      if (t.kind === "cash") cashRefunds += t.amountMinor;
    }
  }
  const sum = (k: string) =>
    moves.filter((m) => m.kind === k).reduce((n, m) => n + m.amount_minor, 0);
  const shift = toShift(row);
  const payIn = sum("pay_in");
  const payOut = sum("pay_out");
  const floatAdded = sum("float_add");
  const drops = sum("drop");
  return {
    shift,
    salesCount,
    salesMinor,
    returnsCount: returns.length,
    returnsMinor,
    voidedCount,
    byTender,
    cashSalesMinor: cashSales,
    cashRefundsMinor: cashRefunds,
    payInMinor: payIn,
    payOutMinor: payOut,
    floatAddedMinor: floatAdded,
    dropsMinor: drops,
    expectedCashMinor:
      shift.openingFloatMinor + cashSales + payIn + floatAdded - cashRefunds - payOut - drops,
  };
}

export interface CloseResult {
  readonly report: ZReport;
  readonly countedMinor: number;
  /** Counted minus expected: positive is over, negative is short. */
  readonly varianceMinor: number;
}

/**
 * Closes the open shift with the counted cash. Blind counting hides the expected amount from the cashier until after
 * the count is entered (the UI decides what to show; the numbers are the same). The report is stored with the shift.
 */
export async function closeShift(
  deps: ShiftDeps,
  o: { countedMinor: number; blind: boolean; note?: string },
): Promise<CloseResult> {
  if (!deps.has(SHIFT_PERMISSION))
    throw new ShiftError("forbidden", "You are not allowed to close the shift.");
  if (!isMoney(o.countedMinor))
    throw new ShiftError("bad_amount", "The count is not a valid amount.");
  return deps.transaction(async (tx) => {
    const open = await tx.get<Raw>("SELECT * FROM local_shifts WHERE closed_at IS NULL LIMIT 1");
    if (open === undefined) throw new ShiftError("no_shift", "There is no open shift.");
    const report = await zReport(tx, open.id);
    const at = deps.now();
    await tx.run(
      "UPDATE local_shifts SET closed_at = ?, counted_minor = ?, expected_minor = ? WHERE id = ?",
      [at, o.countedMinor, report.expectedCashMinor, open.id],
    );
    await tx.enqueue("close_shift", {
      id: open.id,
      operatorId: deps.operatorId,
      closedAt: new Date(at).toISOString(),
      countedCashMinor: o.countedMinor,
      blindCount: o.blind,
      ...(o.note === undefined || o.note.trim() === "" ? {} : { note: o.note.trim() }),
    });
    return {
      report,
      countedMinor: o.countedMinor,
      varianceMinor: o.countedMinor - report.expectedCashMinor,
    };
  });
}
