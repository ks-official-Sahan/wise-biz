import { DomainError } from "@wise-biz/errors";

import { toQty4 } from "../domain/qty.ts";
import { ReturnCompletedV1 } from "../events.ts";
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
import type { CompleteReturn } from "@wise-biz/contracts";
import type { TxHandle } from "@wise-biz/db";

export interface ReturnReceipt {
  readonly returnId: string;
  readonly flags: readonly string[];
}

async function stored(tx: TxHandle, tenantId: string, id: string): Promise<ReturnReceipt> {
  const r = await tx.query<{ flags: string[] }>(
    "select flags from sales.returns where tenant_id = $1 and id = $2",
    [tenantId, id],
  );
  return { returnId: id, flags: one(r.rows).flags };
}

interface SoldLine {
  line: number;
  variant_id: string;
  qty: string;
  total_minor: string;
  returned: string;
  refunded: string;
}

/**
 * Against the original sale (locked FOR UPDATE, so concurrent partial returns serialize): every line names a sale
 * line of the same variant, and what was already returned plus this return never exceeds what was sold, in quantity
 * or in refund.
 */
async function checkAgainstSale(
  tx: TxHandle,
  t: TerminalContext,
  cmd: CompleteReturn,
  saleId: string,
) {
  const s = await tx.query<{ status: string; branch_id: string; currency: string }>(
    "select status, branch_id, currency from sales.sales where tenant_id = $1 and id = $2 for update",
    [t.tenantId, saleId],
  );
  const sale = s.rows[0];
  if (sale?.branch_id !== t.branchId) return invalid("saleId", "Unknown sale for this branch.");
  if (sale.status !== "completed") return invalid("saleId", "A voided sale cannot be returned.");
  if (sale.currency !== cmd.currency)
    throw new DomainError(
      "CURRENCY_MISMATCH",
      "The return currency differs from the sale currency.",
    );
  const sold = await tx.query<SoldLine>(
    `select sl.line, sl.variant_id, sl.qty::text, sl.total_minor,
       coalesce(sum(rl.qty), 0)::text as returned, coalesce(sum(rl.refund_minor), 0) as refunded
     from sales.sale_lines sl
     left join sales.return_lines rl
       on rl.tenant_id = sl.tenant_id and rl.sale_id = sl.sale_id and rl.sale_line = sl.line
     where sl.tenant_id = $1 and sl.sale_id = $2
     group by sl.line, sl.variant_id, sl.qty, sl.total_minor`,
    [t.tenantId, saleId],
  );
  const byLine = new Map(sold.rows.map((r) => [r.line, r]));
  // Several return lines may name one sale line: add them up before comparing.
  const asked = new Map<number, { qty: bigint; refund: number }>();
  for (const [i, l] of cmd.lines.entries()) {
    const ref = byLine.get(l.saleLine ?? -1);
    if (ref?.variant_id !== l.variantId)
      invalid(`lines.${String(i)}.saleLine`, "This line is not on the original sale.");
    const a = asked.get(l.saleLine ?? -1) ?? { qty: 0n, refund: 0 };
    asked.set(l.saleLine ?? -1, { qty: a.qty + toQty4(l.qty), refund: a.refund + l.refundMinor });
  }
  for (const [line, a] of asked) {
    const ref = byLine.get(line);
    /* v8 ignore next -- every key came from a line checked above */
    if (ref === undefined) continue;
    if (toQty4(ref.returned) + a.qty > toQty4(ref.qty))
      invalid("lines", `Return quantity exceeds the quantity sold on line ${String(line)}.`);
    if (Number(ref.refunded) + a.refund > Number(ref.total_minor))
      invalid("lines", `Refund exceeds the amount paid on line ${String(line)}.`);
  }
}

/**
 * CompleteReturn: partial or full, with refund tenders. Restocked lines go back to their location (and batch);
 * written-off lines are recorded but never re-enter sellable stock. A no-receipt return needs an override granting
 * `sales:return_no_receipt`.
 */
export async function completeReturn(
  tx: TxHandle,
  ports: SalesPorts,
  t: TerminalContext,
  cmd: CompleteReturn,
  options: SalesOptions = {},
): Promise<Applied<ReturnReceipt>> {
  const o = { ...DEFAULT_OPTIONS, ...options };
  if (await seen(tx, t, "return", cmd.id, cmd.meta)) {
    return { body: await stored(tx, t.tenantId, cmd.id), replayed: true };
  }
  const occurredAt = new Date(cmd.occurredAt);
  assertDocumentTime(t, occurredAt, "occurredAt", o);
  const shift = await lockOpenShift(tx, t, cmd.shiftId, "share");
  if (shift.currency !== cmd.currency)
    throw new DomainError(
      "CURRENCY_MISMATCH",
      "The return currency differs from the shift currency.",
    );
  if (cmd.saleId !== null) await checkAgainstSale(tx, t, cmd, cmd.saleId);

  const flags = new Set(await operatorFlags(tx, ports.tenancy, t, cmd.operatorId, "sales:return"));
  if (cmd.overrideId !== undefined) {
    const need = {
      permission: cmd.saleId === null ? "sales:return_no_receipt" : "sales:return",
      operatorId: cmd.operatorId,
      subjectId: cmd.saleId,
    };
    for (const f of await overrideFlags(tx, t, cmd.overrideId, need)) flags.add(f);
  }
  const flagList = [...flags].sort();
  const restock: StockMovement[] = cmd.lines.flatMap((l, i) =>
    l.disposition === "restock"
      ? [
          {
            locationId: l.locationId,
            variantId: l.variantId,
            batchId: l.batchId ?? null,
            qty: l.qty,
            reason: "return" as const,
            sourceLine: i,
          },
        ]
      : [],
  );

  return pgErrors(async () => {
    await tx.query(
      `insert into sales.returns (id, tenant_id, branch_id, terminal_id, shift_id, operator_id, sale_id, return_no,
         currency, total_minor, business_date, reason, override_id, flags, occurred_at, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        cmd.id,
        t.tenantId,
        t.branchId,
        t.terminalId,
        cmd.shiftId,
        cmd.operatorId,
        cmd.saleId,
        cmd.returnNo,
        cmd.currency,
        cmd.totalMinor,
        cmd.businessDate,
        cmd.reason,
        cmd.overrideId ?? null,
        flagList,
        occurredAt,
        t.now,
      ],
    );
    await insertChain(tx, t, "return", cmd.id, cmd.meta);
    await tx.query(
      `insert into sales.return_lines (tenant_id, return_id, line, sale_id, sale_line, variant_id, name, sku,
         location_id, batch_id, qty, refund_minor, tax_minor, disposition)
       select $1, $2, l.line, $3, l.sale_line, l.variant_id, l.name, l.sku, l.location_id, l.batch_id, l.qty,
         l.refund_minor, l.tax_minor, l.disposition
       from jsonb_to_recordset($4::jsonb) as l(line int, sale_line int, variant_id uuid, name text, sku text,
         location_id uuid, batch_id uuid, qty numeric, refund_minor bigint, tax_minor bigint, disposition text)`,
      [
        t.tenantId,
        cmd.id,
        cmd.saleId,
        JSON.stringify(
          cmd.lines.map((l, i) => ({
            line: i,
            sale_line: l.saleLine ?? null,
            variant_id: l.variantId,
            name: l.name,
            sku: l.sku,
            location_id: l.locationId,
            batch_id: l.batchId ?? null,
            qty: l.qty,
            refund_minor: l.refundMinor,
            tax_minor: l.taxMinor,
            disposition: l.disposition,
          })),
        ),
      ],
    );
    await tx.query(
      `insert into sales.return_tenders (id, tenant_id, return_id, kind, amount_minor)
       select x.id, $1, $2, x.kind, x.amount_minor
       from jsonb_to_recordset($3::jsonb) as x(id uuid, kind text, amount_minor bigint)`,
      [
        t.tenantId,
        cmd.id,
        JSON.stringify(
          cmd.tenders.map((x) => ({ id: x.id, kind: x.kind, amount_minor: x.amountMinor })),
        ),
      ],
    );
    const stock = await ports.inventory.recordMovements(
      tx,
      commandContext(t, cmd.operatorId),
      { type: "return", id: cmd.id, occurredAt },
      restock,
      {},
    );
    await commit(
      tx,
      t,
      {
        action: "sales.return.complete",
        entity: "return",
        entityId: cmd.id,
        after: {
          saleId: cmd.saleId,
          operatorId: cmd.operatorId,
          returnNo: cmd.returnNo,
          totalMinor: cmd.totalMinor,
          currency: cmd.currency,
          lines: cmd.lines.length,
          overrideId: cmd.overrideId ?? null,
          flags: flagList,
        },
        reason: cmd.reason,
      },
      [
        salesEvent(ReturnCompletedV1, t, `return/${cmd.id}`, {
          returnId: cmd.id,
          saleId: cmd.saleId,
          shiftId: cmd.shiftId,
          operatorId: cmd.operatorId,
          returnNo: cmd.returnNo,
          currency: cmd.currency,
          totalMinor: cmd.totalMinor,
          businessDate: cmd.businessDate,
          occurredAt: occurredAt.toISOString(),
          overrideId: cmd.overrideId ?? null,
          flags: flagList,
          lines: cmd.lines.map((l, i) => ({
            line: i,
            saleLine: l.saleLine ?? null,
            variantId: l.variantId,
            sku: l.sku,
            locationId: l.locationId,
            batchId: l.batchId ?? null,
            qty: l.qty,
            refundMinor: l.refundMinor,
            taxMinor: l.taxMinor,
            disposition: l.disposition,
          })),
          tenders: cmd.tenders.map((x) => ({ kind: x.kind, amountMinor: x.amountMinor })),
        }),
        ...stock.events,
      ],
    );
    return { body: { returnId: cmd.id, flags: flagList }, replayed: false };
  });
}
