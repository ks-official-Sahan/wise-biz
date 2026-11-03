import { z } from "zod";

/** The one method both a consumer's PoolClient and the API's tenant transaction offer. */
export interface Q {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

const int = z.number().int();
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal = z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const tender = z.object({ kind: z.string().min(1).max(40), amountMinor: int });

/**
 * Tolerant readers of the sales events (consumer-driven: no import of the sales module). Only the fields reporting
 * needs; anything else the producer sends is ignored, so sales can add fields without breaking this module.
 */
export const ShiftOpened = z.object({
  tenantId: uuid,
  data: z.object({
    shiftId: uuid,
    branchId: uuid,
    terminalId: uuid,
    businessDate: date,
    currency,
  }),
});
export const SaleCompleted = z.object({
  tenantId: uuid,
  data: z.object({
    saleId: uuid,
    branchId: uuid,
    terminalId: uuid,
    businessDate: date,
    currency,
    subtotalMinor: int,
    discountMinor: int,
    feeMinor: int,
    taxMinor: int,
    payableMinor: int,
    lines: z.array(
      z.object({
        variantId: uuid,
        sku: z.string(),
        qty: decimal,
        discountMinor: int,
        taxMinor: int,
        totalMinor: int,
        unitCostMinor: int.nullable(),
      }),
    ),
    tenders: z.array(tender),
  }),
});
export const SaleVoided = z.object({
  tenantId: uuid,
  data: z.object({ saleId: uuid }),
});
export const ReturnCompleted = z.object({
  tenantId: uuid,
  data: z.object({
    returnId: uuid,
    shiftId: uuid,
    businessDate: date,
    currency,
    totalMinor: int,
    lines: z.array(z.object({ variantId: uuid, sku: z.string(), qty: decimal, refundMinor: int })),
    tenders: z.array(tender),
  }),
});

interface Line {
  variantId: string;
  sku: string;
  qty: string;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  unitCostMinor: number | null;
}
interface Tender {
  kind: string;
  amountMinor: number;
}
export interface SaleFact {
  tenantId: string;
  saleId: string;
  branchId: string;
  terminalId: string;
  businessDate: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  feeMinor: number;
  taxMinor: number;
  payableMinor: number;
  lines: Line[];
  tenders: Tender[];
}
export interface ReturnFact {
  tenantId: string;
  returnId: string;
  branchId: string;
  terminalId: string;
  businessDate: string;
  currency: string;
  totalMinor: number;
  lines: { variantId: string; sku: string; qty: string; refundMinor: number }[];
  tenders: Tender[];
}

/**
 * A rebuild deletes a range and re-reads the facts; a consumer adding a fact in between would be counted twice. Events
 * take the tenant's reporting lock shared (they never block each other), a rebuild takes it exclusive.
 */
async function lock(q: Q, tenantId: string, exclusive: boolean): Promise<void> {
  await q.query(
    exclusive
      ? "select pg_advisory_xact_lock(hashtextextended($1, 0))"
      : "select pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
    [`reporting:${tenantId}`],
  );
}

/** Quantities have up to 4 decimals: sum them as integers in 1/10000, so no float drift reaches a rollup. */
const SCALE = 10_000;
const scaled = (qty: string): number => Math.round(Number(qty) * SCALE);
const unscaled = (n: number): string => (n / SCALE).toFixed(4);

interface SkuAgg {
  variantId: string;
  sku: string;
  qty: number;
  revenue: number;
  discount: number;
  tax: number;
  cost: number;
}
function bySku(lines: readonly Line[], sign: 1 | -1): SkuAgg[] {
  const m = new Map<string, SkuAgg>();
  for (const l of lines) {
    const a = m.get(l.variantId) ?? {
      variantId: l.variantId,
      sku: l.sku,
      qty: 0,
      revenue: 0,
      discount: 0,
      tax: 0,
      cost: 0,
    };
    const q = scaled(l.qty);
    a.qty += sign * q;
    a.revenue += sign * l.totalMinor;
    a.discount += sign * l.discountMinor;
    a.tax += sign * l.taxMinor;
    // Cost of the line: unit cost times quantity, rounded once per line (the same rule the sale uses for margin).
    a.cost += sign * (l.unitCostMinor === null ? 0 : Math.round((l.unitCostMinor * q) / SCALE));
    m.set(l.variantId, a);
  }
  // Rows are locked in this order by the upsert: sorting keeps two sales that share products from deadlocking.
  return [...m.values()].sort((a, b) =>
    a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0,
  );
}
function byKind(
  tenders: readonly Tender[],
  sign: 1 | -1,
): { kind: string; count: number; minor: number }[] {
  const m = new Map<string, { kind: string; count: number; minor: number }>();
  for (const t of tenders) {
    const a = m.get(t.kind) ?? { kind: t.kind, count: 0, minor: 0 };
    a.count += sign;
    a.minor += sign * t.amountMinor;
    m.set(t.kind, a);
  }
  return [...m.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** Adds (+1) or removes (-1) one completed sale from every rollup. A void is the removal plus a void count. */
async function applySale(q: Q, f: SaleFact, sign: 1 | -1): Promise<void> {
  const voided = sign === -1;
  await q.query(
    `insert into reporting.rollup_day
       (tenant_id, business_date, branch_id, terminal_id, currency, sales_count, subtotal_minor, discount_minor,
        fee_minor, tax_minor, payable_minor, voids_count, voids_payable_minor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (tenant_id, business_date, branch_id, terminal_id, currency) do update set
       sales_count = reporting.rollup_day.sales_count + excluded.sales_count,
       subtotal_minor = reporting.rollup_day.subtotal_minor + excluded.subtotal_minor,
       discount_minor = reporting.rollup_day.discount_minor + excluded.discount_minor,
       fee_minor = reporting.rollup_day.fee_minor + excluded.fee_minor,
       tax_minor = reporting.rollup_day.tax_minor + excluded.tax_minor,
       payable_minor = reporting.rollup_day.payable_minor + excluded.payable_minor,
       voids_count = reporting.rollup_day.voids_count + excluded.voids_count,
       voids_payable_minor = reporting.rollup_day.voids_payable_minor + excluded.voids_payable_minor`,
    [
      f.tenantId,
      f.businessDate,
      f.branchId,
      f.terminalId,
      f.currency,
      sign,
      sign * f.subtotalMinor,
      sign * f.discountMinor,
      sign * f.feeMinor,
      sign * f.taxMinor,
      sign * f.payableMinor,
      voided ? 1 : 0,
      voided ? f.payableMinor : 0,
    ],
  );
  const skus = bySku(f.lines, sign).map((a) => ({
    variant_id: a.variantId,
    sku: a.sku,
    qty: unscaled(a.qty),
    revenue: a.revenue,
    discount: a.discount,
    tax: a.tax,
    cost: a.cost,
  }));
  if (skus.length > 0)
    await q.query(
      `insert into reporting.rollup_sku_day
         (tenant_id, business_date, branch_id, variant_id, sku, currency, qty, revenue_minor, discount_minor,
          tax_minor, cost_minor)
       select $1, $2, $3, r.variant_id, r.sku, $4, r.qty, r.revenue, r.discount, r.tax, r.cost
         from jsonb_to_recordset($5::jsonb) as r(variant_id uuid, sku text, qty numeric, revenue bigint,
                                                   discount bigint, tax bigint, cost bigint)
       on conflict (tenant_id, business_date, branch_id, variant_id, currency) do update set
         qty = reporting.rollup_sku_day.qty + excluded.qty,
         revenue_minor = reporting.rollup_sku_day.revenue_minor + excluded.revenue_minor,
         discount_minor = reporting.rollup_sku_day.discount_minor + excluded.discount_minor,
         tax_minor = reporting.rollup_sku_day.tax_minor + excluded.tax_minor,
         cost_minor = reporting.rollup_sku_day.cost_minor + excluded.cost_minor`,
      [f.tenantId, f.businessDate, f.branchId, f.currency, JSON.stringify(skus)],
    );
  const kinds = byKind(f.tenders, sign);
  if (kinds.length > 0)
    await q.query(
      `insert into reporting.rollup_tender_day
         (tenant_id, business_date, branch_id, kind, currency, tx_count, sales_minor)
       select $1, $2, $3, r.kind, $4, r.count, r.minor
         from jsonb_to_recordset($5::jsonb) as r(kind text, count int, minor bigint)
       on conflict (tenant_id, business_date, branch_id, kind, currency) do update set
         tx_count = reporting.rollup_tender_day.tx_count + excluded.tx_count,
         sales_minor = reporting.rollup_tender_day.sales_minor + excluded.sales_minor`,
      [f.tenantId, f.businessDate, f.branchId, f.currency, JSON.stringify(kinds)],
    );
}

async function applyReturn(q: Q, f: ReturnFact): Promise<void> {
  await q.query(
    `insert into reporting.rollup_day
       (tenant_id, business_date, branch_id, terminal_id, currency, returns_count, returns_minor)
     values ($1, $2, $3, $4, $5, 1, $6)
     on conflict (tenant_id, business_date, branch_id, terminal_id, currency) do update set
       returns_count = reporting.rollup_day.returns_count + 1,
       returns_minor = reporting.rollup_day.returns_minor + excluded.returns_minor`,
    [f.tenantId, f.businessDate, f.branchId, f.terminalId, f.currency, f.totalMinor],
  );
  const m = new Map<string, { variant_id: string; sku: string; qty: number; refund: number }>();
  for (const l of f.lines) {
    const a = m.get(l.variantId) ?? { variant_id: l.variantId, sku: l.sku, qty: 0, refund: 0 };
    a.qty += scaled(l.qty);
    a.refund += l.refundMinor;
    m.set(l.variantId, a);
  }
  const skus = [...m.values()]
    .sort((a, b) => (a.variant_id < b.variant_id ? -1 : a.variant_id > b.variant_id ? 1 : 0))
    .map((a) => ({ ...a, qty: unscaled(a.qty) }));
  if (skus.length > 0)
    await q.query(
      `insert into reporting.rollup_sku_day
         (tenant_id, business_date, branch_id, variant_id, sku, currency, returned_qty, refund_minor)
       select $1, $2, $3, r.variant_id, r.sku, $4, r.qty, r.refund
         from jsonb_to_recordset($5::jsonb) as r(variant_id uuid, sku text, qty numeric, refund bigint)
       on conflict (tenant_id, business_date, branch_id, variant_id, currency) do update set
         returned_qty = reporting.rollup_sku_day.returned_qty + excluded.returned_qty,
         refund_minor = reporting.rollup_sku_day.refund_minor + excluded.refund_minor`,
      [f.tenantId, f.businessDate, f.branchId, f.currency, JSON.stringify(skus)],
    );
  const kinds = byKind(f.tenders, 1).map((k) => ({ kind: k.kind, minor: k.minor }));
  if (kinds.length > 0)
    await q.query(
      `insert into reporting.rollup_tender_day (tenant_id, business_date, branch_id, kind, currency, refunds_minor)
       select $1, $2, $3, r.kind, $4, r.minor
         from jsonb_to_recordset($5::jsonb) as r(kind text, minor bigint)
       on conflict (tenant_id, business_date, branch_id, kind, currency) do update set
         refunds_minor = reporting.rollup_tender_day.refunds_minor + excluded.refunds_minor`,
      [f.tenantId, f.businessDate, f.branchId, f.currency, JSON.stringify(kinds)],
    );
}

// ---- event handlers (each runs in the consumer's transaction; redelivery changes nothing) ----

export async function onShiftOpened(q: Q, payload: unknown): Promise<void> {
  const e = ShiftOpened.parse(payload);
  await lock(q, e.tenantId, false);
  await q.query(
    `insert into reporting.shift_facts (tenant_id, shift_id, branch_id, terminal_id, business_date, currency)
     values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
    [
      e.tenantId,
      e.data.shiftId,
      e.data.branchId,
      e.data.terminalId,
      e.data.businessDate,
      e.data.currency,
    ],
  );
}

/** Returns true when the sale was new (the rollups moved). */
export async function onSaleCompleted(q: Q, payload: unknown): Promise<boolean> {
  const e = SaleCompleted.parse(payload);
  await lock(q, e.tenantId, false);
  const d = e.data;
  const r = await q.query(
    `insert into reporting.sale_facts
       (tenant_id, sale_id, branch_id, terminal_id, business_date, currency, subtotal_minor, discount_minor,
        fee_minor, tax_minor, payable_minor, lines, tenders)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
     on conflict do nothing`,
    [
      e.tenantId,
      d.saleId,
      d.branchId,
      d.terminalId,
      d.businessDate,
      d.currency,
      d.subtotalMinor,
      d.discountMinor,
      d.feeMinor,
      d.taxMinor,
      d.payableMinor,
      JSON.stringify(d.lines),
      JSON.stringify(d.tenders),
    ],
  );
  if (r.rowCount !== 1) return false;
  await applySale(q, { tenantId: e.tenantId, ...d }, 1);
  return true;
}

/** Returns true when the void moved the rollups. A void for a sale not seen yet throws, so the bus retries it. */
export async function onSaleVoided(q: Q, payload: unknown): Promise<boolean> {
  const e = SaleVoided.parse(payload);
  await lock(q, e.tenantId, false);
  const r = await q.query(
    `update reporting.sale_facts set status = 'voided'
      where tenant_id = $1 and sale_id = $2 and status = 'completed'
      returning sale_id`,
    [e.tenantId, e.data.saleId],
  );
  if (r.rowCount !== 1) {
    const seen = await q.query(
      "select 1 from reporting.sale_facts where tenant_id = $1 and sale_id = $2",
      [e.tenantId, e.data.saleId],
    );
    if (seen.rowCount === 1) return false; // already voided: a redelivery
    throw new Error("sale not projected yet: retry the void");
  }
  const f = await loadSale(q, e.tenantId, e.data.saleId);
  await applySale(q, f, -1);
  return true;
}

export async function onReturnCompleted(q: Q, payload: unknown): Promise<boolean> {
  const e = ReturnCompleted.parse(payload);
  await lock(q, e.tenantId, false);
  const d = e.data;
  const shift = await q.query(
    "select branch_id, terminal_id from reporting.shift_facts where tenant_id = $1 and shift_id = $2",
    [e.tenantId, d.shiftId],
  );
  const s = shift.rows[0];
  if (s === undefined) throw new Error("shift not projected yet: retry the return");
  const f: ReturnFact = {
    tenantId: e.tenantId,
    returnId: d.returnId,
    branchId: String(s.branch_id),
    terminalId: String(s.terminal_id),
    businessDate: d.businessDate,
    currency: d.currency,
    totalMinor: d.totalMinor,
    lines: d.lines,
    tenders: d.tenders,
  };
  const r = await q.query(
    `insert into reporting.return_facts
       (tenant_id, return_id, branch_id, terminal_id, business_date, currency, total_minor, lines, tenders)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) on conflict do nothing`,
    [
      f.tenantId,
      f.returnId,
      f.branchId,
      f.terminalId,
      f.businessDate,
      f.currency,
      f.totalMinor,
      JSON.stringify(f.lines),
      JSON.stringify(f.tenders),
    ],
  );
  if (r.rowCount !== 1) return false;
  await applyReturn(q, f);
  return true;
}

async function loadSale(q: Q, tenantId: string, saleId: string): Promise<SaleFact> {
  const r = await q.query(
    `select branch_id, terminal_id, business_date::text as business_date, currency, subtotal_minor, discount_minor,
            fee_minor, tax_minor, payable_minor, lines, tenders
       from reporting.sale_facts where tenant_id = $1 and sale_id = $2`,
    [tenantId, saleId],
  );
  return toSale(tenantId, saleId, r.rows[0] ?? {});
}
const toSale = (tenantId: string, saleId: string, r: Record<string, unknown>): SaleFact => ({
  tenantId,
  saleId,
  branchId: String(r.branch_id),
  terminalId: String(r.terminal_id),
  businessDate: String(r.business_date),
  currency: String(r.currency),
  subtotalMinor: Number(r.subtotal_minor),
  discountMinor: Number(r.discount_minor),
  feeMinor: Number(r.fee_minor),
  taxMinor: Number(r.tax_minor),
  payableMinor: Number(r.payable_minor),
  lines: r.lines as Line[],
  tenders: r.tenders as Tender[],
});

/**
 * Recompute the rollups of a date range from the facts: delete the range, then apply every fact again with the same
 * code the consumer uses, so a rebuild can never disagree with the incremental result. A voided sale is its addition
 * and removal, which leaves only its void count. Safe to repeat.
 */
export async function rebuild(
  q: Q,
  tenantId: string,
  from: string,
  to: string,
): Promise<{ sales: number; returns: number }> {
  await lock(q, tenantId, true);
  for (const table of ["rollup_day", "rollup_sku_day", "rollup_tender_day"]) {
    await q.query(
      `delete from reporting.${table} where tenant_id = $1 and business_date between $2 and $3`,
      [tenantId, from, to],
    );
  }
  const sales = await q.query(
    `select sale_id, status, branch_id, terminal_id, business_date::text as business_date, currency, subtotal_minor,
            discount_minor, fee_minor, tax_minor, payable_minor, lines, tenders
       from reporting.sale_facts
      where tenant_id = $1 and business_date between $2 and $3 order by business_date, sale_id`,
    [tenantId, from, to],
  );
  for (const r of sales.rows) {
    const f = toSale(tenantId, String(r.sale_id), r);
    await applySale(q, f, 1);
    if (r.status === "voided") await applySale(q, f, -1);
  }
  const returns = await q.query(
    `select return_id, branch_id, terminal_id, business_date::text as business_date, currency, total_minor, lines,
            tenders
       from reporting.return_facts
      where tenant_id = $1 and business_date between $2 and $3 order by business_date, return_id`,
    [tenantId, from, to],
  );
  for (const r of returns.rows) {
    await applyReturn(q, {
      tenantId,
      returnId: String(r.return_id),
      branchId: String(r.branch_id),
      terminalId: String(r.terminal_id),
      businessDate: String(r.business_date),
      currency: String(r.currency),
      totalMinor: Number(r.total_minor),
      lines: r.lines as ReturnFact["lines"],
      tenders: r.tenders as Tender[],
    });
  }
  return { sales: sales.rows.length, returns: returns.rows.length };
}
