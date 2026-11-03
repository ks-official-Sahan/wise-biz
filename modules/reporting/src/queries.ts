import type { Q } from "./apply.ts";

export interface Range {
  readonly from: string;
  readonly to: string;
  /** Only these branches (undefined: all of them). The HTTP layer sets it from the filter and the caller's branch scope. */
  readonly branchIds?: readonly string[] | undefined;
}

const n = (v: unknown): number => Number(v);

export type GroupBy = "day" | "branch" | "terminal";
const GROUP_COLUMN: Readonly<Record<GroupBy, string>> = {
  day: "business_date::text",
  branch: "branch_id::text",
  terminal: "terminal_id::text",
};

/** Sales net of voids, with voids and returns beside them. One index range scan over a few thousand rollup rows. */
export async function salesSummary(q: Q, tenantId: string, r: Range, by: GroupBy) {
  const col = GROUP_COLUMN[by];
  const res = await q.query(
    `select ${col} as key, currency,
            sum(sales_count) as sales_count, sum(subtotal_minor) as subtotal_minor,
            sum(discount_minor) as discount_minor, sum(fee_minor) as fee_minor, sum(tax_minor) as tax_minor,
            sum(payable_minor) as payable_minor, sum(voids_count) as voids_count,
            sum(voids_payable_minor) as voids_payable_minor, sum(returns_count) as returns_count,
            sum(returns_minor) as returns_minor
       from reporting.rollup_day
      where tenant_id = $1 and business_date between $2 and $3 and ($4::uuid[] is null or branch_id = any($4::uuid[]))
      group by key, currency order by key, currency`,
    [tenantId, r.from, r.to, r.branchIds === undefined ? null : [...r.branchIds]],
  );
  return res.rows.map((x) => ({
    key: String(x.key),
    currency: String(x.currency),
    salesCount: n(x.sales_count),
    subtotalMinor: n(x.subtotal_minor),
    discountMinor: n(x.discount_minor),
    feeMinor: n(x.fee_minor),
    taxMinor: n(x.tax_minor),
    payableMinor: n(x.payable_minor),
    voidsCount: n(x.voids_count),
    voidsPayableMinor: n(x.voids_payable_minor),
    returnsCount: n(x.returns_count),
    returnsMinor: n(x.returns_minor),
    netMinor: n(x.payable_minor) - n(x.returns_minor),
  }));
}

/**
 * Best sellers by revenue. Money columns are what was sold (tax included) before returns; the net of tax and the
 * profit are likewise before returns, and the refunded amount is shown beside them.
 */
export async function products(q: Q, tenantId: string, r: Range, limit: number) {
  const res = await q.query(
    `select variant_id::text as variant_id, max(sku) as sku, currency, sum(qty) as qty,
            sum(revenue_minor) as revenue_minor, sum(tax_minor) as tax_minor, sum(discount_minor) as discount_minor,
            sum(cost_minor) as cost_minor, sum(returned_qty) as returned_qty, sum(refund_minor) as refund_minor
       from reporting.rollup_sku_day
      where tenant_id = $1 and business_date between $2 and $3 and ($4::uuid[] is null or branch_id = any($4::uuid[]))
      group by variant_id, currency order by sum(revenue_minor) desc, variant_id limit $5`,
    [tenantId, r.from, r.to, r.branchIds === undefined ? null : [...r.branchIds], limit],
  );
  return res.rows.map((x) => {
    const revenue = n(x.revenue_minor);
    const tax = n(x.tax_minor);
    const cost = n(x.cost_minor);
    return {
      variantId: String(x.variant_id),
      sku: String(x.sku),
      currency: String(x.currency),
      qty: String(x.qty),
      revenueMinor: revenue,
      taxMinor: tax,
      discountMinor: n(x.discount_minor),
      costMinor: cost,
      netMinor: revenue - tax,
      profitMinor: revenue - tax - cost,
      returnedQty: String(x.returned_qty),
      refundMinor: n(x.refund_minor),
    };
  });
}

export async function payments(q: Q, tenantId: string, r: Range) {
  const res = await q.query(
    `select kind, currency, sum(tx_count) as tx_count, sum(sales_minor) as sales_minor,
            sum(refunds_minor) as refunds_minor
       from reporting.rollup_tender_day
      where tenant_id = $1 and business_date between $2 and $3 and ($4::uuid[] is null or branch_id = any($4::uuid[]))
      group by kind, currency order by sum(sales_minor) desc, kind`,
    [tenantId, r.from, r.to, r.branchIds === undefined ? null : [...r.branchIds]],
  );
  return res.rows.map((x) => ({
    kind: String(x.kind),
    currency: String(x.currency),
    count: n(x.tx_count),
    salesMinor: n(x.sales_minor),
    refundsMinor: n(x.refunds_minor),
    netMinor: n(x.sales_minor) - n(x.refunds_minor),
  }));
}

/** Sales per operator over a range (staff report). The nil UUID is "unknown": sales before operators were recorded. */
export async function operators(q: Q, tenantId: string, r: Range) {
  const res = await q.query(
    `select operator_id, currency, sum(sales_count) as sales_count, sum(payable_minor) as payable_minor,
            sum(discount_minor) as discount_minor, sum(voids_count) as voids_count,
            sum(voids_payable_minor) as voids_payable_minor
       from reporting.rollup_operator_day
      where tenant_id = $1 and business_date between $2 and $3 and ($4::uuid[] is null or branch_id = any($4::uuid[]))
      group by operator_id, currency order by sum(payable_minor) desc, operator_id`,
    [tenantId, r.from, r.to, r.branchIds === undefined ? null : [...r.branchIds]],
  );
  return res.rows.map((x) => {
    const count = n(x.sales_count);
    const payable = n(x.payable_minor);
    return {
      operatorId: String(x.operator_id),
      currency: String(x.currency),
      salesCount: count,
      payableMinor: payable,
      averageMinor: count === 0 ? 0 : Math.round(payable / count),
      discountMinor: n(x.discount_minor),
      voidsCount: n(x.voids_count),
      voidsPayableMinor: n(x.voids_payable_minor),
    };
  });
}

/** Tax collected per day (rollup_day carries the sale-level tax; per-rate lines are a later rollup). */
export async function tax(q: Q, tenantId: string, r: Range) {
  const res = await q.query(
    `select business_date::text as day, currency, sum(tax_minor) as tax_minor, sum(payable_minor) as payable_minor
       from reporting.rollup_day
      where tenant_id = $1 and business_date between $2 and $3 and ($4::uuid[] is null or branch_id = any($4::uuid[]))
      group by business_date, currency order by business_date, currency`,
    [tenantId, r.from, r.to, r.branchIds === undefined ? null : [...r.branchIds]],
  );
  return res.rows.map((x) => ({
    day: String(x.day),
    currency: String(x.currency),
    taxMinor: n(x.tax_minor),
    payableMinor: n(x.payable_minor),
    netOfTaxMinor: n(x.payable_minor) - n(x.tax_minor),
  }));
}

/** One CSV cell: quoted when needed, and a leading = + - @ is defused so a spreadsheet never runs it as a formula. */
export function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) && typeof value === "string" ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number)[])[],
): string {
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
