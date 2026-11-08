import { divRound } from "@wise-biz/money";

import { toQty4, fromQty4 } from "../../sell/model/qty.ts";
import { ensureShift } from "../../shift/model/shift.ts";
import { businessDateOf } from "../../tender/model/sale-command.ts";

import type { Approval } from "../../../state/slices.ts";
import type { OutboxTx, Queryable } from "@wise-biz/sync";

/** Sales are kept this long on the device for returns, voids and reprints (older ones need an online lookup). */
export const SALE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RETURN_PERMISSION = "sales:return";
export const NO_RECEIPT_PERMISSION = "sales:return_no_receipt";

export interface SoldLine {
  readonly variantId: string;
  readonly name: string;
  readonly sku: string;
  readonly locationId: string;
  readonly batchId?: string | null;
  readonly qty: string;
  readonly unitPriceMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

export interface StoredSale {
  readonly id: string;
  readonly saleNo: number;
  readonly shiftId: string;
  readonly completedAt: number;
  readonly voidedAt?: number;
  /** Who rang the sale up (absent on sales stored before this was kept). */
  readonly operatorId?: string;
  readonly currency: string;
  readonly payableMinor: number;
  readonly lines: readonly SoldLine[];
  readonly tenders: readonly {
    readonly id: string;
    readonly kind: string;
    readonly amountMinor: number;
    readonly card?: { readonly providerRef?: string; readonly last4?: string };
  }[];
}

interface SaleRow {
  readonly id: string;
  readonly shift_id: string;
  readonly sale_no: number;
  readonly completed_at: number;
  readonly body: string;
  readonly voided_at: number | null;
}

function toSale(r: SaleRow): StoredSale {
  const b = JSON.parse(r.body) as Omit<
    StoredSale,
    "id" | "saleNo" | "shiftId" | "completedAt" | "voidedAt"
  >;
  return {
    id: r.id,
    saleNo: r.sale_no,
    shiftId: r.shift_id,
    completedAt: r.completed_at,
    ...(r.voided_at === null ? {} : { voidedAt: r.voided_at }),
    ...(b.operatorId === undefined ? {} : { operatorId: b.operatorId }),
    currency: b.currency,
    payableMinor: b.payableMinor,
    lines: b.lines,
    tenders: b.tenders,
  };
}

/** Recent sales of this terminal, newest first; a number filters by sale number. */
export async function recentSales(
  q: Queryable,
  o: { limit?: number; saleNo?: number; now: number },
): Promise<StoredSale[]> {
  const rows =
    o.saleNo === undefined
      ? await q.all<SaleRow>(
          "SELECT id, shift_id, sale_no, completed_at, body, voided_at FROM local_sales WHERE completed_at >= ? ORDER BY completed_at DESC LIMIT ?",
          [o.now - SALE_RETENTION_MS, o.limit ?? 20],
        )
      : await q.all<SaleRow>(
          "SELECT id, shift_id, sale_no, completed_at, body, voided_at FROM local_sales WHERE sale_no = ? AND completed_at >= ? ORDER BY completed_at DESC LIMIT 5",
          [o.saleNo, o.now - SALE_RETENTION_MS],
        );
  return rows.map(toSale);
}

export async function saleById(q: Queryable, id: string): Promise<StoredSale | undefined> {
  const r = await q.get<SaleRow>(
    "SELECT id, shift_id, sale_no, completed_at, body, voided_at FROM local_sales WHERE id = ?",
    [id],
  );
  return r === undefined ? undefined : toSale(r);
}

export interface ReturnableLine {
  readonly saleLine: number;
  readonly line: SoldLine;
  /** Quantity not yet returned. */
  readonly qtyLeft: string;
  /** Money already refunded for this line by earlier returns. */
  readonly refundedMinor: number;
}

interface ReturnBody {
  readonly lines: readonly { saleLine?: number; qty: string; refundMinor?: number }[];
}

/** What can still come back from a sale: sold quantity minus every return already made against it (on this terminal). */
export async function returnableLines(q: Queryable, sale: StoredSale): Promise<ReturnableLine[]> {
  if (sale.voidedAt !== undefined) return [];
  const prior = await q.all<{ body: string }>("SELECT body FROM local_returns WHERE sale_id = ?", [
    sale.id,
  ]);
  const returned = new Map<number, number>();
  const refunded = new Map<number, number>();
  for (const r of prior) {
    for (const l of (JSON.parse(r.body) as ReturnBody).lines) {
      if (l.saleLine === undefined) continue;
      returned.set(l.saleLine, (returned.get(l.saleLine) ?? 0) + (toQty4(l.qty) ?? 0));
      refunded.set(l.saleLine, (refunded.get(l.saleLine) ?? 0) + (l.refundMinor ?? 0));
    }
  }
  return sale.lines.flatMap((line, saleLine) => {
    const left = (toQty4(line.qty) ?? 0) - (returned.get(saleLine) ?? 0);
    return left > 0
      ? [{ saleLine, line, qtyLeft: fromQty4(left), refundedMinor: refunded.get(saleLine) ?? 0 }]
      : [];
  });
}

/**
 * Money back for `qty` of a sold line: the line's paid total (after discounts, with its tax) in proportion to the
 * quantity, rounded half-up. Returning the whole remaining quantity refunds exactly what is left of the line, so
 * partial returns never add up to more or less than the line was paid.
 */
export function refundFor(
  line: SoldLine,
  qtyLeft: string,
  qty: string,
  refundedSoFarMinor: number,
): { refundMinor: number; taxMinor: number } {
  const sold = toQty4(line.qty) ?? 1;
  const want = toQty4(qty) ?? 0;
  const left = toQty4(qtyLeft) ?? 0;
  if (want <= 0 || want > left) return { refundMinor: 0, taxMinor: 0 };
  const remainingMinor = line.totalMinor - refundedSoFarMinor;
  if (want === left) {
    const tax = share(line.taxMinor, want, sold);
    return { refundMinor: remainingMinor, taxMinor: Math.min(tax, remainingMinor) };
  }
  const refund = Math.min(remainingMinor, share(line.totalMinor, want, sold));
  return {
    refundMinor: refund,
    taxMinor: Math.min(refund, share(line.taxMinor, want, sold)),
  };
}

/** `amount * want / sold` in exact integer arithmetic, half up (money is never rounded through floats). */
function share(amountMinor: number, want: number, sold: number): number {
  return Number(divRound(BigInt(amountMinor) * BigInt(want), BigInt(sold), "half-up"));
}

export interface ReturnLineInput {
  readonly saleLine: number;
  readonly qty: string;
  readonly disposition: "restock" | "writeoff";
}

export interface ReturnDeps {
  readonly transaction: <T>(fn: (tx: OutboxTx) => Promise<T>) => Promise<T>;
  readonly now: () => number;
  readonly newId: () => string;
  readonly operatorId: string;
  readonly locationOf: (variantId: string) => string;
  readonly has: (permission: string) => boolean;
}

export class ReturnError extends Error {
  override readonly name = "ReturnError";
  readonly code:
    | "nothing"
    | "over_return"
    | "voided"
    | "needs_override"
    | "no_sale"
    | "reason_required"
    | "bad_refund";
  constructor(code: ReturnError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface CommittedReturn {
  readonly returnId: string;
  readonly returnNo: number;
  readonly totalMinor: number;
  readonly cashMinor: number;
}

/**
 * Returns lines of a sale. Checked against what is left to return (a line already returned in full, or more than was
 * sold, is refused here and again by the server). The refund goes back as cash unless a card tender is passed that
 * already refunded through the terminal (`cardRefunds`). Restocked lines add stock back; write-offs do not. A return
 * needs `sales:return` or a supervisor approval, which is signed into the chain ahead of it.
 */
export async function commitReturn(
  deps: ReturnDeps,
  o: {
    sale: StoredSale;
    lines: readonly ReturnLineInput[];
    reason: string;
    approval?: Approval;
    /** Card refunds already made through the payment terminal, by original tender id. */
    cardRefunds?: readonly {
      tenderId: string;
      amountMinor: number;
      providerRef: string;
      last4?: string;
    }[];
  },
): Promise<CommittedReturn> {
  const reason = o.reason.trim();
  if (reason === "") throw new ReturnError("reason_required", "Add a reason for the return.");
  if (o.lines.length === 0) throw new ReturnError("nothing", "Pick something to return.");
  // An approval only counts when it is for this permission: one granted for another action must not unlock a return.
  if (!deps.has(RETURN_PERMISSION) && o.approval?.permission !== RETURN_PERMISSION) {
    throw new ReturnError("needs_override", "A supervisor must approve this return.");
  }
  return deps.transaction(async (tx) => {
    const sale = await saleById(tx, o.sale.id);
    if (sale === undefined) throw new ReturnError("no_sale", "That sale is not on this terminal.");
    if (sale.voidedAt !== undefined) throw new ReturnError("voided", "That sale was voided.");
    const left = new Map((await returnableLines(tx, sale)).map((r) => [r.saleLine, r]));
    const priorRefund = new Map<number, number>();
    for (const r of await tx.all<{ body: string }>(
      "SELECT body FROM local_returns WHERE sale_id = ?",
      [sale.id],
    )) {
      for (const l of (
        JSON.parse(r.body) as { lines: { saleLine?: number; refundMinor: number }[] }
      ).lines) {
        if (l.saleLine !== undefined)
          priorRefund.set(l.saleLine, (priorRefund.get(l.saleLine) ?? 0) + l.refundMinor);
      }
    }
    // One entry per sold line: two entries for the same line would each be checked against the full remainder.
    if (new Set(o.lines.map((l) => l.saleLine)).size !== o.lines.length) {
      throw new ReturnError("over_return", "Each sold line can appear once in a return.");
    }
    const lines = o.lines.map((input) => {
      const r = left.get(input.saleLine);
      const want = toQty4(input.qty);
      if (r === undefined || want === undefined || want <= 0 || want > (toQty4(r.qtyLeft) ?? 0)) {
        throw new ReturnError("over_return", "That is more than was sold, or already returned.");
      }
      const money = refundFor(r.line, r.qtyLeft, input.qty, priorRefund.get(input.saleLine) ?? 0);
      return {
        saleLine: input.saleLine,
        variantId: r.line.variantId,
        name: r.line.name,
        sku: r.line.sku,
        locationId: r.line.locationId,
        ...(r.line.batchId === undefined ? {} : { batchId: r.line.batchId }),
        qty: input.qty,
        refundMinor: money.refundMinor,
        taxMinor: money.taxMinor,
        disposition: input.disposition,
      };
    });
    const totalMinor = lines.reduce((n, l) => n + l.refundMinor, 0);
    const card = o.cardRefunds ?? [];
    const cardTotal = card.reduce((n, c) => n + c.amountMinor, 0);
    if (card.some((c) => !Number.isSafeInteger(c.amountMinor) || c.amountMinor <= 0)) {
      throw new ReturnError("bad_refund", "A card refund must be a positive amount.");
    }
    if (cardTotal > totalMinor)
      throw new ReturnError("over_return", "Card refunds exceed the return total.");
    // Money goes back the way it came. A card refund names the card payment it reverses and cannot exceed what that
    // payment still holds; cash back is limited to what was paid in cash when the sale also had card payments.
    const paidBy = new Map(sale.tenders.map((t) => [t.id, t] as const));
    const refundedBefore = new Map<string, number>();
    let cashBefore = 0;
    for (const r of await tx.all<{ body: string }>(
      "SELECT body FROM local_returns WHERE sale_id = ?",
      [sale.id],
    )) {
      for (const t of (
        JSON.parse(r.body) as {
          tenders?: { kind: string; amountMinor: number; card?: { providerRef?: string } }[];
        }
      ).tenders ?? []) {
        if (t.kind === "cash") cashBefore += t.amountMinor;
      }
    }
    for (const c of card) {
      const original = paidBy.get(c.tenderId);
      if (original?.kind !== "card") {
        throw new ReturnError("bad_refund", "A card refund must name a card payment of this sale.");
      }
      const used = (refundedBefore.get(c.tenderId) ?? 0) + c.amountMinor;
      refundedBefore.set(c.tenderId, used);
      if (used > original.amountMinor) {
        throw new ReturnError("bad_refund", "That is more than the card payment holds.");
      }
    }
    const cashPaid = sale.tenders
      .filter((t) => t.kind === "cash")
      .reduce((n, t) => n + t.amountMinor, 0);
    const paidByCard = sale.tenders.some((t) => t.kind === "card");
    // Cash rounding at the till makes the lines add up to a little more than was paid; that difference is allowed.
    const rounding = Math.max(
      0,
      sale.lines.reduce((n, l) => n + l.totalMinor, 0) - sale.payableMinor,
    );
    if (paidByCard && totalMinor - cardTotal + cashBefore > cashPaid + rounding) {
      throw new ReturnError(
        "bad_refund",
        "This sale was paid by card: refund the card for that part.",
      );
    }
    const tenders = [
      ...card.map((c) => ({
        id: deps.newId(),
        kind: "card" as const,
        amountMinor: c.amountMinor,
        card: {
          provider: "terminal",
          providerRef: c.providerRef,
          ...(c.last4 === undefined ? {} : { last4: c.last4 }),
        },
      })),
      ...(totalMinor - cardTotal > 0
        ? [{ id: deps.newId(), kind: "cash" as const, amountMinor: totalMinor - cardTotal }]
        : []),
    ];

    const at = deps.now();
    const businessDate = businessDateOf(at);
    const shift = await ensureShift(tx, deps, {
      completedAt: at,
      businessDate,
      currency: sale.currency,
    });
    const rn = await tx.get<{ value: string }>("SELECT value FROM kv WHERE key = 'pos.return_no'");
    const returnNo = (rn === undefined ? 0 : Number(rn.value)) + 1;
    await tx.run(
      "INSERT INTO kv (key, value) VALUES ('pos.return_no', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [String(returnNo)],
    );
    const returnId = deps.newId();
    if (o.approval !== undefined) {
      await tx.enqueue("record_override", {
        id: o.approval.id,
        requesterId: o.approval.requesterId,
        approverId: o.approval.approverId,
        permission: o.approval.permission,
        reason: o.approval.reason,
        subjectType: "return",
        subjectId: returnId,
        occurredAt: new Date(o.approval.at).toISOString(),
      });
    }
    const body = {
      id: returnId,
      saleId: sale.id,
      shiftId: shift.id,
      operatorId: deps.operatorId,
      returnNo,
      currency: sale.currency,
      businessDate,
      occurredAt: new Date(at).toISOString(),
      reason,
      ...(o.approval === undefined ? {} : { overrideId: o.approval.id }),
      lines,
      tenders,
      totalMinor,
    };
    await tx.enqueue("complete_return", body);
    await tx.run(
      "INSERT INTO local_returns (id, sale_id, shift_id, return_no, occurred_at, body) VALUES (?, ?, ?, ?, ?, ?)",
      [returnId, sale.id, shift.id, returnNo, at, JSON.stringify(body)],
    );
    for (const l of lines) {
      if (l.disposition !== "restock") continue;
      await tx.run(
        "INSERT INTO local_movements (id, variant_id, location_id, batch_id, qty, ref_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        [deps.newId(), l.variantId, l.locationId, l.qty, returnId, at],
      );
    }
    return { returnId, returnNo, totalMinor, cashMinor: totalMinor - cardTotal };
  });
}
