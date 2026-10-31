import { DomainError } from "@wise-biz/errors";

import { negate } from "../domain/qty.ts";
import { SaleVoidedV1 } from "../events.ts";
import { DEFAULT_OPTIONS } from "../ports.ts";

import {
  assertDocumentTime,
  commandContext,
  commit,
  insertChain,
  invalid,
  lockOpenShift,
  one,
  operatorFlags,
  overrideFlags,
  pgErrors,
  salesEvent,
  seen,
} from "./shared.ts";

import type { Applied } from "./sale.ts";
import type { SalesOptions, SalesPorts, StockMovement, TerminalContext } from "../ports.ts";
import type { VoidSale } from "@wise-biz/contracts";
import type { TxHandle } from "@wise-biz/db";

export interface VoidReceipt {
  readonly voidId: string;
  readonly saleId: string;
  readonly flags: readonly string[];
}

async function stored(tx: TxHandle, tenantId: string, id: string): Promise<VoidReceipt> {
  const r = await tx.query<{ sale_id: string; flags: string[] }>(
    "select sale_id, flags from sales.voids where tenant_id = $1 and id = $2",
    [tenantId, id],
  );
  const row = one(r.rows);
  return { voidId: id, saleId: row.sale_id, flags: row.flags };
}

/**
 * VoidSale: cancels a whole sale. Within the void window (default 30 min after completion) the operator's own
 * permission is enough; later it needs an override granting `sales:void_late` (412 with that permission otherwise).
 * A sale with returns cannot be voided (return the rest instead), and a voided sale accepts no returns. The sale row
 * is locked FOR UPDATE, so a void and a return of one sale never both pass their checks.
 */
export async function voidSale(
  tx: TxHandle,
  ports: SalesPorts,
  t: TerminalContext,
  cmd: VoidSale,
  options: SalesOptions = {},
): Promise<Applied<VoidReceipt>> {
  const o = { ...DEFAULT_OPTIONS, ...options };
  if (await seen(tx, t, "void", cmd.id, cmd.meta)) {
    return { body: await stored(tx, t.tenantId, cmd.id), replayed: true };
  }
  const occurredAt = new Date(cmd.occurredAt);
  assertDocumentTime(t, occurredAt, "occurredAt", o);
  await lockOpenShift(tx, t, cmd.shiftId, "share");
  const s = await tx.query<{
    status: string;
    branch_id: string;
    invoice_no: string;
    payable_minor: string;
    currency: string;
    completed_at: Date;
    stock: {
      locationId: string;
      variantId: string;
      batchId?: string | null;
      qty: string;
      sourceLine: number;
    }[];
  }>(
    `select s.status, s.branch_id, s.invoice_no, s.payable_minor, s.currency, s.completed_at, s.stock
     from sales.sales s where s.tenant_id = $1 and s.id = $2 for update of s`,
    [t.tenantId, cmd.saleId],
  );
  const sale = s.rows[0];
  if (sale?.branch_id !== t.branchId) return invalid("saleId", "Unknown sale for this branch.");
  if (sale.status !== "completed") return invalid("saleId", "This sale is already voided.");
  // A separate statement AFTER the lock: it sees returns that committed while this void waited for the sale row.
  const returned = await tx.query(
    "select 1 from sales.returns where tenant_id = $1 and sale_id = $2 limit 1",
    [t.tenantId, cmd.saleId],
  );
  if (returned.rowCount === 1)
    return invalid("saleId", "This sale has returns. Return the remaining items instead.");

  const flags = new Set(await operatorFlags(tx, ports.tenancy, t, cmd.operatorId, "sales:void"));
  if (occurredAt.getTime() < sale.completed_at.getTime())
    return invalid("occurredAt", "A void cannot be older than the sale.");
  // The window runs to the server's receive time, so a backdated void cannot skip the override.
  const late = t.now.getTime() - sale.completed_at.getTime() > o.voidWindowMs;
  if (late && cmd.overrideId === undefined) {
    throw new DomainError("PRECONDITION_FAILED", "Voiding this late needs a supervisor override.", {
      details: { permission: "sales:void_late" },
    });
  }
  if (cmd.overrideId !== undefined) {
    const need = {
      permission: late ? "sales:void_late" : "sales:void",
      operatorId: cmd.operatorId,
      subjectId: cmd.saleId,
    };
    for (const f of await overrideFlags(tx, t, cmd.overrideId, need)) flags.add(f);
  }
  const flagList = [...flags].sort();
  // Reverse exactly what the sale recorded (after its FEFO re-allocation), line for line.
  const reversal: StockMovement[] = sale.stock.map((m) => ({
    locationId: m.locationId,
    variantId: m.variantId,
    batchId: m.batchId ?? null,
    qty: negate(m.qty),
    reason: "return",
    sourceLine: m.sourceLine,
  }));

  return pgErrors(async () => {
    await tx.query(
      `insert into sales.voids (id, tenant_id, sale_id, shift_id, terminal_id, operator_id, reason, override_id, flags,
         occurred_at, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        cmd.id,
        t.tenantId,
        cmd.saleId,
        cmd.shiftId,
        t.terminalId,
        cmd.operatorId,
        cmd.reason,
        cmd.overrideId ?? null,
        flagList,
        occurredAt,
        t.now,
      ],
    );
    await insertChain(tx, t, "void", cmd.id, cmd.meta);
    await tx.query("update sales.sales set status = 'voided' where tenant_id = $1 and id = $2", [
      t.tenantId,
      cmd.saleId,
    ]);
    const stock = await ports.inventory.recordMovements(
      tx,
      commandContext(t, cmd.operatorId),
      { type: "void", id: cmd.id, occurredAt },
      reversal,
      {},
    );
    await commit(
      tx,
      t,
      {
        action: "sales.sale.void",
        entity: "sale",
        entityId: cmd.saleId,
        before: { status: "completed" },
        after: {
          status: "voided",
          voidId: cmd.id,
          operatorId: cmd.operatorId,
          overrideId: cmd.overrideId ?? null,
          flags: flagList,
        },
        reason: cmd.reason,
      },
      [
        salesEvent(SaleVoidedV1, t, `sale/${cmd.saleId}`, {
          saleId: cmd.saleId,
          voidId: cmd.id,
          invoiceNo: sale.invoice_no,
          operatorId: cmd.operatorId,
          overrideId: cmd.overrideId ?? null,
          reason: cmd.reason,
          payableMinor: Number(sale.payable_minor),
          currency: sale.currency,
          occurredAt: occurredAt.toISOString(),
          flags: flagList,
          stock: reversal.map((m) => ({
            variantId: m.variantId,
            locationId: m.locationId,
            batchId: m.batchId ?? null,
            qty: m.qty,
          })),
        }),
        ...stock.events,
      ],
    );
    return { body: { voidId: cmd.id, saleId: cmd.saleId, flags: flagList }, replayed: false };
  });
}
