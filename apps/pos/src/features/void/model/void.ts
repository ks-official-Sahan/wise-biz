import { saleById } from "../../returns/model/returns.ts";
import { ensureShift } from "../../shift/model/shift.ts";
import { businessDateOf } from "../../tender/model/sale-command.ts";

import type { Approval } from "../../../state/slices.ts";
import type { OutboxTx } from "@wise-biz/sync";

/** A sale can be voided by its own operator this long after completion; later needs `sales:void` or a supervisor. */
export const VOID_WINDOW_MS = 15 * 60 * 1000;
export const VOID_PERMISSION = "sales:void";

export interface VoidDeps {
  readonly transaction: <T>(fn: (tx: OutboxTx) => Promise<T>) => Promise<T>;
  readonly now: () => number;
  readonly newId: () => string;
  readonly operatorId: string;
  readonly has: (permission: string) => boolean;
}

export class VoidError extends Error {
  override readonly name = "VoidError";
  readonly code: "no_sale" | "already" | "returned" | "needs_override" | "reason_required";
  constructor(code: VoidError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** True when a void needs a supervisor: outside the window and without the permission. */
export function voidNeedsOverride(
  completedAt: number,
  now: number,
  has: (p: string) => boolean,
): boolean {
  return now - completedAt > VOID_WINDOW_MS && !has(VOID_PERMISSION);
}

/**
 * Voids a whole sale: stock goes back, the cash goes back from the drawer of the shift the void happens in. A sale that
 * already has returns cannot be voided (return the rest instead), and a sale cannot be voided twice.
 */
export async function voidSale(
  deps: VoidDeps,
  o: { saleId: string; reason: string; approval?: Approval },
): Promise<{ voidId: string }> {
  const reason = o.reason.trim();
  if (reason === "") throw new VoidError("reason_required", "Add a reason for the void.");
  return deps.transaction(async (tx) => {
    const sale = await saleById(tx, o.saleId);
    if (sale === undefined) throw new VoidError("no_sale", "That sale is not on this terminal.");
    if (sale.voidedAt !== undefined) throw new VoidError("already", "That sale is already voided.");
    const returned = await tx.get<{ n: number }>(
      "SELECT count(*) AS n FROM local_returns WHERE sale_id = ?",
      [sale.id],
    );
    if ((returned?.n ?? 0) > 0)
      throw new VoidError("returned", "Part of this sale was returned. Return the rest instead.");
    const at = deps.now();
    if (voidNeedsOverride(sale.completedAt, at, deps.has) && o.approval === undefined) {
      throw new VoidError("needs_override", "A supervisor must approve a void after 15 minutes.");
    }
    const shift = await ensureShift(tx, deps, {
      completedAt: at,
      businessDate: businessDateOf(at),
      currency: sale.currency,
    });
    const voidId = deps.newId();
    if (o.approval !== undefined) {
      await tx.enqueue("record_override", {
        id: o.approval.id,
        requesterId: o.approval.requesterId,
        approverId: o.approval.approverId,
        permission: o.approval.permission,
        reason: o.approval.reason,
        subjectType: "void",
        subjectId: voidId,
        occurredAt: new Date(o.approval.at).toISOString(),
      });
    }
    await tx.enqueue("void_sale", {
      id: voidId,
      saleId: sale.id,
      shiftId: shift.id,
      operatorId: deps.operatorId,
      occurredAt: new Date(at).toISOString(),
      reason,
      ...(o.approval === undefined ? {} : { overrideId: o.approval.id }),
    });
    await tx.run("UPDATE local_sales SET voided_at = ?, voided_shift_id = ? WHERE id = ?", [
      at,
      shift.id,
      sale.id,
    ]);
    for (const l of sale.lines) {
      await tx.run(
        "INSERT INTO local_movements (id, variant_id, location_id, batch_id, qty, ref_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        [deps.newId(), l.variantId, l.locationId, l.qty, voidId, at],
      );
    }
    return { voidId };
  });
}
