import { DomainError } from "@wise-biz/errors";

import { SaleCompletedV1 } from "../events.ts";
import { DEFAULT_OPTIONS } from "../ports.ts";

import {
  assertDocumentTime,
  assertReplay,
  commandContext,
  commit,
  insertChain,
  invalid,
  lockDocument,
  one,
  operatorFlags,
  pgErrors,
  salesEvent,
} from "./shared.ts";

import type {
  BatchFacts,
  SalesOptions,
  SalesPorts,
  StockMovement,
  TerminalContext,
} from "../ports.ts";
import type { CompleteSale } from "@wise-biz/contracts";
import type { TxHandle } from "@wise-biz/db";

export interface SaleReceipt {
  readonly saleId: string;
  readonly invoiceNo: string;
  readonly status: "completed" | "voided";
  readonly flags: readonly string[];
}

export interface Applied<B> {
  readonly body: B;
  /** True when the document was already recorded: nothing was written, the stored answer is returned. */
  readonly replayed: boolean;
}

/** One sourceLine per stock movement: a sale line re-allocated over several batches gets line*1000 + k. */
const LINE_STRIDE = 1000;

async function storedReceipt(tx: TxHandle, tenantId: string, saleId: string): Promise<SaleReceipt> {
  const r = await tx.query<{ invoice_no: string; status: "completed" | "voided"; flags: string[] }>(
    "select invoice_no, status, flags from sales.sales where tenant_id = $1 and id = $2",
    [tenantId, saleId],
  );
  const row = one(r.rows);
  return { saleId, invoiceNo: row.invoice_no, status: row.status, flags: row.flags };
}

async function alreadyRecorded(tx: TxHandle, tenantId: string, saleId: string): Promise<boolean> {
  await lockDocument(tx, tenantId, saleId);
  const r = await tx.query(
    "select 1 from sales.device_documents where tenant_id = $1 and doc_type = 'sale' and doc_id = $2",
    [tenantId, saleId],
  );
  return r.rowCount === 1;
}

/**
 * Re-price with the server's engine (ADR 0014). Only when the device priced with the SAME inputs (list snapshot,
 * engine, applied promotions) can a difference be the device's fault: within tolerance it is flagged, beyond it the
 * sale is rejected. Any other difference (an older snapshot, a promotion that ended since, a cart the server can no
 * longer price) is accepted and flagged `stale_price`: the customer already paid what the device showed.
 */
async function priceCheck(
  tx: TxHandle,
  ports: SalesPorts,
  tolerance: { bps: number; minMinor: number },
  t: TerminalContext,
  cmd: CompleteSale,
): Promise<string[]> {
  let q;
  try {
    q = await ports.pricing.quote(
      tx,
      t.tenantId,
      {
        priceListId: cmd.priceListId,
        lines: cmd.lines.map((l, i) => ({
          id: String(i),
          variantId: l.variantId,
          qty: l.qty,
          ...(l.priceSource === "override" ? { priceOverrideMinor: l.unitPriceMinor } : {}),
          ...(l.batchId == null ? {} : { batchId: l.batchId }),
        })),
        ...(cmd.coupons === undefined ? {} : { coupons: cmd.coupons }),
        ...(cmd.customerGroup === undefined ? {} : { customerGroup: cmd.customerGroup }),
      },
      new Date(cmd.completedAt),
    );
  } catch (e) {
    // The quote raises its validation errors before any failing SQL, so the transaction is still usable.
    if (e instanceof DomainError && e.code === "VALIDATION_FAILED") return ["stale_price"];
    throw e;
  }
  const applied = new Set(
    q.lines.flatMap((l) => [...l.lineDiscounts, ...l.cartDiscounts].map((d) => d.promotionId)),
  );
  const declared = new Set(cmd.promotionIds);
  const samePromos = applied.size === declared.size && [...applied].every((p) => declared.has(p));
  const sameInputs =
    q.priceListId === `${cmd.priceListId}:${String(cmd.priceListVersion)}` &&
    q.engine === cmd.engineVersion &&
    samePromos;
  if (!sameInputs) return ["stale_price"];
  const diff = Math.abs(q.payableMinor - cmd.payableMinor);
  if (diff === 0) return [];
  const allowed = Math.max(
    tolerance.minMinor,
    Math.floor((q.payableMinor * tolerance.bps) / 10_000),
  );
  if (diff <= allowed) return ["price_mismatch"];
  throw new DomainError("PRICE_MISMATCH", "The sale total does not match the server price.", {
    details: { devicePayableMinor: cmd.payableMinor, serverPayableMinor: q.payableMinor },
  });
}

interface PlannedLine {
  readonly batchId: string | null;
  readonly unitCostMinor: number | null;
}

/**
 * Stock out per line, with the batch the device chose (FEFO on the device). A batch the server does not know for
 * that variant is re-allocated FEFO here; whatever the batches cannot cover leaves the no-batch balance (negative is
 * allowed offline and announced by inventory). Selling an expired batch already happened at the till: recorded and
 * flagged, never refused.
 */
async function planStock(
  tx: TxHandle,
  ports: SalesPorts,
  t: TerminalContext,
  cmd: CompleteSale,
): Promise<{ movements: StockMovement[]; lines: PlannedLine[]; flags: string[] }> {
  const wanted = cmd.lines.flatMap((l) => (l.batchId == null ? [] : [l.batchId]));
  const facts =
    wanted.length === 0
      ? new Map<string, BatchFacts>()
      : await ports.inventory.batches(tx, t.tenantId, wanted);
  const movements: StockMovement[] = [];
  const lines: PlannedLine[] = [];
  const flags = new Set<string>();
  for (const [i, l] of cmd.lines.entries()) {
    const base = { locationId: l.locationId, variantId: l.variantId, reason: "sale" as const };
    const known = l.batchId == null ? undefined : facts.get(l.batchId);
    if (l.batchId == null) {
      movements.push({ ...base, qty: `-${l.qty}`, sourceLine: i * LINE_STRIDE });
      lines.push({ batchId: null, unitCostMinor: null });
    } else if (known?.variantId === l.variantId) {
      if (known.expiresOn !== null && known.expiresOn < cmd.businessDate)
        flags.add("expired_batch");
      movements.push({
        ...base,
        batchId: l.batchId,
        qty: `-${l.qty}`,
        sourceLine: i * LINE_STRIDE,
        unitCostMinor: known.unitCostMinor,
      });
      lines.push({ batchId: l.batchId, unitCostMinor: known.unitCostMinor });
    } else {
      flags.add("batch_reallocated");
      const fefo = await ports.inventory.selectBatchesFefo(tx, t.tenantId, {
        locationId: l.locationId,
        variantId: l.variantId,
        qty: l.qty,
        today: cmd.businessDate,
      });
      let k = 0;
      for (const a of fefo.allocations) {
        movements.push({
          ...base,
          batchId: a.batchId,
          qty: `-${a.qty}`,
          sourceLine: i * LINE_STRIDE + k++,
        });
      }
      if (/[1-9]/.test(fefo.shortfall)) {
        movements.push({ ...base, qty: `-${fefo.shortfall}`, sourceLine: i * LINE_STRIDE + k });
      }
      const only = fefo.allocations.length === 1 && !/[1-9]/.test(fefo.shortfall);
      lines.push({
        batchId: only ? (fefo.allocations[0]?.batchId ?? null) : null,
        unitCostMinor: null,
      });
    }
  }
  return { movements, lines, flags: [...flags] };
}

/** Gapless per branch: taken last, so the per-branch row lock is held for the shortest time and a rollback frees it. */
async function nextInvoiceNo(tx: TxHandle, t: TerminalContext): Promise<string> {
  const r = await tx.query<{ prefix: string; last_no: string }>(
    `insert into sales.invoice_sequences as s (tenant_id, branch_id, last_no) values ($1, $2, 1)
     on conflict (tenant_id, branch_id) do update set last_no = s.last_no + 1
     returning prefix, last_no`,
    [t.tenantId, t.branchId],
  );
  const row = one(r.rows);
  return `${row.prefix}-${row.last_no.padStart(6, "0")}`;
}

/**
 * CompleteSale (P1-05): one transaction writes the sale, its lines and tenders, the chain row, the stock movements,
 * the invoice number, the audit row and the outbox events. Applying the same document again returns the stored answer.
 */
export async function completeSale(
  tx: TxHandle,
  ports: SalesPorts,
  t: TerminalContext,
  cmd: CompleteSale,
  options: SalesOptions = {},
): Promise<Applied<SaleReceipt>> {
  const o = { ...DEFAULT_OPTIONS, ...options };
  if (await alreadyRecorded(tx, t.tenantId, cmd.id)) {
    await assertReplay(tx, t, "sale", cmd.id, cmd.meta);
    return { body: await storedReceipt(tx, t.tenantId, cmd.id), replayed: true };
  }
  const completedAt = new Date(cmd.completedAt);
  assertDocumentTime(t, completedAt, "completedAt", o);

  // FOR SHARE: CloseShift locks the row FOR UPDATE, so its cash count never misses a sale committing beside it.
  const shift = await tx.query<{ terminal_id: string; status: string; currency: string }>(
    "select terminal_id, status, currency from sales.shifts where tenant_id = $1 and id = $2 for share",
    [t.tenantId, cmd.shiftId],
  );
  const s = shift.rows[0];
  if (s?.terminal_id !== t.terminalId)
    return invalid("shiftId", "Unknown shift for this terminal.");
  if (s.status !== "open") return invalid("shiftId", "This shift is closed.");
  if (s.currency !== cmd.currency)
    throw new DomainError(
      "CURRENCY_MISMATCH",
      "The sale currency differs from the shift currency.",
    );

  const flags = new Set([
    ...(await operatorFlags(tx, ports.tenancy, t, cmd.operatorId, "sales:sell", cmd.policyVersion)),
    ...(await priceCheck(tx, ports, o.priceTolerance, t, cmd)),
  ]);
  const stock = await planStock(tx, ports, t, cmd);
  for (const f of stock.flags) flags.add(f);
  const flagList = [...flags].sort();

  return pgErrors(async () => {
    const ins = await tx.query(
      `insert into sales.sales (id, tenant_id, branch_id, terminal_id, shift_id, operator_id, customer_id, sale_no,
         currency, subtotal_minor, discount_minor, fee_minor, tax_minor, total_minor, cash_rounding_minor,
         payable_minor, business_date, price_list_id, price_list_version, engine_version, policy_version,
         promotion_ids, coupons, flags, stock, completed_at, received_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
         $23, $24, $25, $26, $27)
       on conflict (tenant_id, id) do nothing
       returning id`,
      [
        cmd.id,
        t.tenantId,
        t.branchId,
        t.terminalId,
        cmd.shiftId,
        cmd.operatorId,
        cmd.customerId ?? null,
        cmd.saleNo,
        cmd.currency,
        cmd.subtotalMinor,
        cmd.discountMinor,
        cmd.feeMinor,
        cmd.taxMinor,
        cmd.totalMinor,
        cmd.cashRoundingMinor,
        cmd.payableMinor,
        cmd.businessDate,
        cmd.priceListId,
        cmd.priceListVersion,
        cmd.engineVersion,
        cmd.policyVersion,
        cmd.promotionIds,
        cmd.coupons ?? [],
        flagList,
        JSON.stringify(stock.movements),
        completedAt,
        t.now,
      ],
    );
    /* v8 ignore next 4 -- defence in depth: lockDocument already serializes applies of one id */
    if (ins.rowCount === 0) {
      // A concurrent apply of the same id committed first (it held the key until then).
      await assertReplay(tx, t, "sale", cmd.id, cmd.meta);
      return { body: await storedReceipt(tx, t.tenantId, cmd.id), replayed: true };
    }
    await insertChain(tx, t, "sale", cmd.id, cmd.meta);
    await tx.query(
      `insert into sales.sale_lines (tenant_id, sale_id, line, variant_id, name, sku, location_id, batch_id, qty,
         unit_price_minor, price_source, discount_minor, tax_minor, total_minor, unit_cost_minor, detail)
       select $1, $2, l.line, l.variant_id, l.name, l.sku, l.location_id, l.batch_id, l.qty, l.unit_price_minor,
         l.price_source, l.discount_minor, l.tax_minor, l.total_minor, l.unit_cost_minor, l.detail
       from jsonb_to_recordset($3::jsonb) as l(line int, variant_id uuid, name text, sku text, location_id uuid,
         batch_id uuid, qty numeric, unit_price_minor bigint, price_source text, discount_minor bigint,
         tax_minor bigint, total_minor bigint, unit_cost_minor bigint, detail jsonb)`,
      [
        t.tenantId,
        cmd.id,
        JSON.stringify(
          cmd.lines.map((l, i) => ({
            line: i,
            variant_id: l.variantId,
            name: l.name,
            sku: l.sku,
            location_id: l.locationId,
            batch_id: stock.lines[i]?.batchId ?? null,
            qty: l.qty,
            unit_price_minor: l.unitPriceMinor,
            price_source: l.priceSource,
            discount_minor: l.discountMinor,
            tax_minor: l.taxMinor,
            total_minor: l.totalMinor,
            unit_cost_minor: stock.lines[i]?.unitCostMinor ?? null,
            detail: l.detail ?? null,
          })),
        ),
      ],
    );
    await tx.query(
      `insert into sales.sale_tenders (id, tenant_id, sale_id, kind, amount_minor, received_minor, change_minor,
         foreign_currency, foreign_amount_minor, fx_rate, card_provider, card_ref, card_auth_code, card_last4,
         card_brand)
       select x.id, $1, $2, x.kind, x.amount_minor, x.received_minor, x.change_minor, x.foreign_currency,
         x.foreign_amount_minor, x.fx_rate, x.card_provider, x.card_ref, x.card_auth_code, x.card_last4, x.card_brand
       from jsonb_to_recordset($3::jsonb) as x(id uuid, kind text, amount_minor bigint, received_minor bigint,
         change_minor bigint, foreign_currency char(3), foreign_amount_minor bigint, fx_rate numeric,
         card_provider text, card_ref text, card_auth_code text, card_last4 char(4), card_brand text)`,
      [
        t.tenantId,
        cmd.id,
        JSON.stringify(
          cmd.tenders.map((x) => ({
            id: x.id,
            kind: x.kind,
            amount_minor: x.amountMinor,
            received_minor: x.receivedMinor ?? null,
            change_minor: x.changeMinor ?? null,
            foreign_currency: x.foreign?.currency ?? null,
            foreign_amount_minor: x.foreign?.amountMinor ?? null,
            fx_rate: x.foreign?.fxRate ?? null,
            card_provider: x.card?.provider ?? null,
            card_ref: x.card?.providerRef ?? null,
            card_auth_code: x.card?.authCode ?? null,
            card_last4: x.card?.last4 ?? null,
            card_brand: x.card?.brand ?? null,
          })),
        ),
      ],
    );
    const stockResult = await ports.inventory.recordMovements(
      tx,
      commandContext(t, cmd.operatorId),
      { type: "sale", id: cmd.id, occurredAt: completedAt },
      stock.movements,
      { sellExpired: true },
    );
    const invoiceNo = await nextInvoiceNo(tx, t);
    await tx.query("update sales.sales set invoice_no = $3 where tenant_id = $1 and id = $2", [
      t.tenantId,
      cmd.id,
      invoiceNo,
    ]);

    const event = salesEvent(SaleCompletedV1, t, `sale/${cmd.id}`, {
      saleId: cmd.id,
      branchId: t.branchId,
      terminalId: t.terminalId,
      shiftId: cmd.shiftId,
      operatorId: cmd.operatorId,
      customerId: cmd.customerId ?? null,
      saleNo: cmd.saleNo,
      invoiceNo,
      currency: cmd.currency,
      businessDate: cmd.businessDate,
      completedAt: completedAt.toISOString(),
      subtotalMinor: cmd.subtotalMinor,
      discountMinor: cmd.discountMinor,
      feeMinor: cmd.feeMinor,
      taxMinor: cmd.taxMinor,
      totalMinor: cmd.totalMinor,
      cashRoundingMinor: cmd.cashRoundingMinor,
      payableMinor: cmd.payableMinor,
      promotionIds: cmd.promotionIds,
      coupons: cmd.coupons ?? [],
      flags: flagList,
      lines: cmd.lines.map((l, i) => ({
        line: i,
        variantId: l.variantId,
        sku: l.sku,
        locationId: l.locationId,
        batchId: stock.lines[i]?.batchId ?? null,
        qty: l.qty,
        unitPriceMinor: l.unitPriceMinor,
        discountMinor: l.discountMinor,
        taxMinor: l.taxMinor,
        totalMinor: l.totalMinor,
        unitCostMinor: stock.lines[i]?.unitCostMinor ?? null,
      })),
      tenders: cmd.tenders.map((x) => ({ kind: x.kind, amountMinor: x.amountMinor })),
    });
    await commit(
      tx,
      t,
      {
        action: "sales.sale.complete",
        entity: "sale",
        entityId: cmd.id,
        after: {
          operatorId: cmd.operatorId,
          saleNo: cmd.saleNo,
          invoiceNo,
          payableMinor: cmd.payableMinor,
          currency: cmd.currency,
          lines: cmd.lines.length,
          flags: flagList,
        },
      },
      [event, ...stockResult.events],
    );
    return {
      body: { saleId: cmd.id, invoiceNo, status: "completed" as const, flags: flagList },
      replayed: false,
    };
  });
}
