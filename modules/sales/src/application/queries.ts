import type { ZReport } from "../events.ts";
import type { SalesQuerySchema, ShiftsQuerySchema } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { z } from "zod";

/** "all", or the branch ids the caller's membership is limited to (an empty list sees nothing). */
export type BranchScope = "all" | readonly string[];

const INCLUDES = new Set(["lines", "tenders", "returns", "void"]);

export function parseIncludes(raw: string | undefined): Set<string> | undefined {
  if (raw === undefined || raw === "") return new Set();
  const parts = raw.split(",");
  return parts.every((p) => INCLUDES.has(p)) ? new Set(parts) : undefined;
}

interface Where {
  readonly sql: string[];
  readonly params: unknown[];
  add(sql: string, v: unknown): void;
}
function where(tenantId: string, scope: BranchScope): Where {
  const w: Where = {
    sql: ["tenant_id = $1"],
    params: [tenantId],
    add(sql, v) {
      w.params.push(v);
      w.sql.push(sql.replace("?", `$${String(w.params.length)}`));
    },
  };
  if (scope !== "all") w.add("branch_id = any(?::uuid[])", [...scope]);
  return w;
}

const iso = (d: Date) => d.toISOString();
const day = (d: Date | string) => (typeof d === "string" ? d : d.toISOString().slice(0, 10));

interface SaleRow {
  id: string;
  branch_id: string;
  terminal_id: string;
  shift_id: string;
  operator_id: string;
  customer_id: string | null;
  sale_no: string;
  invoice_no: string | null;
  status: "completed" | "voided";
  currency: string;
  subtotal_minor: string;
  discount_minor: string;
  fee_minor: string;
  tax_minor: string;
  total_minor: string;
  cash_rounding_minor: string;
  payable_minor: string;
  business_date: string;
  flags: string[];
  completed_at: Date;
}
const SALE_COLS = `id, branch_id, terminal_id, shift_id, operator_id, customer_id, sale_no, invoice_no, status,
  currency, subtotal_minor, discount_minor, fee_minor, tax_minor, total_minor, cash_rounding_minor, payable_minor,
  business_date::text, flags, completed_at`;

const toSale = (r: SaleRow) => ({
  id: r.id,
  branchId: r.branch_id,
  terminalId: r.terminal_id,
  shiftId: r.shift_id,
  operatorId: r.operator_id,
  customerId: r.customer_id,
  saleNo: Number(r.sale_no),
  invoiceNo: r.invoice_no,
  status: r.status,
  currency: r.currency,
  subtotalMinor: Number(r.subtotal_minor),
  discountMinor: Number(r.discount_minor),
  feeMinor: Number(r.fee_minor),
  taxMinor: Number(r.tax_minor),
  totalMinor: Number(r.total_minor),
  cashRoundingMinor: Number(r.cash_rounding_minor),
  payableMinor: Number(r.payable_minor),
  businessDate: day(r.business_date),
  flags: r.flags,
  completedAt: iso(r.completed_at),
});

/**
 * Includes are loaded for the whole page with one query each (`= any(ids)`), so a page costs 1 + (number of
 * includes) queries whatever its size.
 */
async function attach(
  tx: TxHandle,
  tenantId: string,
  sales: ReturnType<typeof toSale>[],
  include: ReadonlySet<string>,
) {
  if (sales.length === 0 || include.size === 0) return sales;
  const ids = sales.map((s) => s.id);
  const group = <T extends { sale_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.sale_id, [...(m.get(r.sale_id) ?? []), r]);
    return m;
  };
  const lines = include.has("lines")
    ? group(
        (
          await tx.query<{
            sale_id: string;
            line: number;
            variant_id: string;
            name: string;
            sku: string;
            location_id: string;
            batch_id: string | null;
            qty: string;
            unit_price_minor: string;
            price_source: "override" | "batch" | "list";
            discount_minor: string;
            tax_minor: string;
            total_minor: string;
            unit_cost_minor: string | null;
          }>(
            `select sale_id, line, variant_id, name, sku, location_id, batch_id, qty::text, unit_price_minor, price_source,
               discount_minor, tax_minor, total_minor, unit_cost_minor
             from sales.sale_lines where tenant_id = $1 and sale_id = any($2::uuid[]) order by sale_id, line`,
            [tenantId, ids],
          )
        ).rows,
      )
    : undefined;
  const tenders = include.has("tenders")
    ? group(
        (
          await tx.query<{
            sale_id: string;
            id: string;
            kind: string;
            amount_minor: string;
            received_minor: string | null;
            change_minor: string | null;
            card_provider: string | null;
            card_ref: string | null;
            card_auth_code: string | null;
            card_last4: string | null;
            card_brand: string | null;
          }>(
            `select sale_id, id, kind, amount_minor, received_minor, change_minor, card_provider, card_ref,
               card_auth_code, card_last4, card_brand
             from sales.sale_tenders where tenant_id = $1 and sale_id = any($2::uuid[]) order by sale_id, id`,
            [tenantId, ids],
          )
        ).rows,
      )
    : undefined;
  let returns: Map<string, unknown[]> | undefined;
  if (include.has("returns")) {
    const rs = await tx.query<{
      id: string;
      sale_id: string;
      return_no: string;
      total_minor: string;
      reason: string;
      flags: string[];
      occurred_at: Date;
    }>(
      `select id, sale_id, return_no, total_minor, reason, flags, occurred_at from sales.returns
       where tenant_id = $1 and sale_id = any($2::uuid[]) order by sale_id, occurred_at, id`,
      [tenantId, ids],
    );
    const rl = await tx.query<{
      return_id: string;
      line: number;
      sale_line: number | null;
      qty: string;
      refund_minor: string;
      disposition: "restock" | "writeoff";
    }>(
      `select return_id, line, sale_line, qty::text, refund_minor, disposition from sales.return_lines
       where tenant_id = $1 and sale_id = any($2::uuid[]) order by return_id, line`,
      [tenantId, ids],
    );
    const byReturn = new Map<string, unknown[]>();
    for (const l of rl.rows) {
      byReturn.set(l.return_id, [
        ...(byReturn.get(l.return_id) ?? []),
        {
          line: l.line,
          saleLine: l.sale_line,
          qty: l.qty,
          refundMinor: Number(l.refund_minor),
          disposition: l.disposition,
        },
      ]);
    }
    returns = new Map();
    for (const r of rs.rows) {
      returns.set(r.sale_id, [
        ...(returns.get(r.sale_id) ?? []),
        {
          id: r.id,
          returnNo: Number(r.return_no),
          totalMinor: Number(r.total_minor),
          reason: r.reason,
          flags: r.flags,
          occurredAt: iso(r.occurred_at),
          lines: byReturn.get(r.id) ?? [],
        },
      ]);
    }
  }
  const voids = include.has("void")
    ? new Map(
        (
          await tx.query<{
            id: string;
            sale_id: string;
            reason: string;
            operator_id: string;
            override_id: string | null;
            occurred_at: Date;
          }>(
            `select id, sale_id, reason, operator_id, override_id, occurred_at from sales.voids
             where tenant_id = $1 and sale_id = any($2::uuid[])`,
            [tenantId, ids],
          )
        ).rows.map((v) => [v.sale_id, v] as const),
      )
    : undefined;
  return sales.map((s) => ({
    ...s,
    ...(lines === undefined
      ? {}
      : {
          lines: (lines.get(s.id) ?? []).map((l) => ({
            line: l.line,
            variantId: l.variant_id,
            name: l.name,
            sku: l.sku,
            locationId: l.location_id,
            batchId: l.batch_id,
            qty: l.qty,
            unitPriceMinor: Number(l.unit_price_minor),
            priceSource: l.price_source,
            discountMinor: Number(l.discount_minor),
            taxMinor: Number(l.tax_minor),
            totalMinor: Number(l.total_minor),
            unitCostMinor: l.unit_cost_minor === null ? null : Number(l.unit_cost_minor),
          })),
        }),
    ...(tenders === undefined
      ? {}
      : {
          tenders: (tenders.get(s.id) ?? []).map((t) => ({
            id: t.id,
            kind: t.kind,
            amountMinor: Number(t.amount_minor),
            receivedMinor: t.received_minor === null ? null : Number(t.received_minor),
            changeMinor: t.change_minor === null ? null : Number(t.change_minor),
            card:
              t.kind === "card"
                ? {
                    provider: t.card_provider,
                    providerRef: t.card_ref,
                    authCode: t.card_auth_code,
                    last4: t.card_last4,
                    brand: t.card_brand,
                  }
                : null,
          })),
        }),
    ...(returns === undefined ? {} : { returns: returns.get(s.id) ?? [] }),
    ...(voids === undefined
      ? {}
      : (() => {
          const v = voids.get(s.id);
          return {
            void:
              v === undefined
                ? null
                : {
                    id: v.id,
                    reason: v.reason,
                    operatorId: v.operator_id,
                    overrideId: v.override_id,
                    occurredAt: iso(v.occurred_at),
                  },
          };
        })()),
  }));
}

/** Newest first by (business_date, id); served by sales_tenant_branch_date_idx or sales_tenant_date_idx. */
export async function listSales(
  tx: TxHandle,
  tenantId: string,
  scope: BranchScope,
  q: z.output<typeof SalesQuerySchema>,
  include: ReadonlySet<string>,
) {
  const limit = q.limit ?? 50;
  const w = where(tenantId, scope);
  if (q.branchId !== undefined) w.add("branch_id = ?", q.branchId);
  if (q.shiftId !== undefined) w.add("shift_id = ?", q.shiftId);
  if (q.customerId !== undefined) w.add("customer_id = ?", q.customerId);
  if (q.status !== undefined) w.add("status = ?", q.status);
  if (q.from !== undefined) w.add("business_date >= ?::date", q.from);
  if (q.to !== undefined) w.add("business_date <= ?::date", q.to);
  if (q.flagged === true) w.sql.push("cardinality(flags) > 0");
  if (q.flag !== undefined) w.add("? = any(flags)", q.flag);
  if (q.after !== undefined) {
    const [d, id] = q.after.split("|");
    w.params.push(d, id);
    w.sql.push(
      `(business_date, id) < ($${String(w.params.length - 1)}::date, $${String(w.params.length)}::uuid)`,
    );
  }
  w.params.push(limit + 1);
  const r = await tx.query<SaleRow>(
    `select ${SALE_COLS} from sales.sales where ${w.sql.join(" and ")}
     order by business_date desc, id desc limit $${String(w.params.length)}`,
    w.params,
  );
  const rows = r.rows.slice(0, limit).map(toSale);
  const last = rows.at(-1);
  return {
    items: await attach(tx, tenantId, rows, include),
    nextCursor:
      r.rows.length > limit && last !== undefined ? `${last.businessDate}|${last.id}` : null,
  };
}

export async function getSale(
  tx: TxHandle,
  tenantId: string,
  scope: BranchScope,
  id: string,
  include: ReadonlySet<string>,
) {
  const w = where(tenantId, scope);
  w.add("id = ?", id);
  const r = await tx.query<SaleRow>(
    `select ${SALE_COLS} from sales.sales where ${w.sql.join(" and ")}`,
    w.params,
  );
  const row = r.rows[0];
  if (row === undefined) return undefined;
  return (await attach(tx, tenantId, [toSale(row)], include))[0];
}

interface ShiftRow {
  id: string;
  branch_id: string;
  terminal_id: string;
  opened_by: string;
  closed_by: string | null;
  business_date: string;
  currency: string;
  status: "open" | "closed";
  opening_float_minor: string;
  expected_cash_minor: string | null;
  counted_cash_minor: string | null;
  over_short_minor: string | null;
  blind_count: boolean | null;
  flags: string[];
  opened_at: Date;
  closed_at: Date | null;
  z_report: ZReport | null;
}
const SHIFT_COLS = `id, branch_id, terminal_id, opened_by, closed_by, business_date::text, currency, status,
  opening_float_minor, expected_cash_minor, counted_cash_minor, over_short_minor, blind_count, flags, opened_at,
  closed_at, z_report`;
const num = (v: string | null) => (v === null ? null : Number(v));
const toShift = (r: ShiftRow) => ({
  id: r.id,
  branchId: r.branch_id,
  terminalId: r.terminal_id,
  openedBy: r.opened_by,
  closedBy: r.closed_by,
  businessDate: day(r.business_date),
  currency: r.currency,
  status: r.status,
  openingFloatMinor: Number(r.opening_float_minor),
  expectedCashMinor: num(r.expected_cash_minor),
  countedCashMinor: num(r.counted_cash_minor),
  overShortMinor: num(r.over_short_minor),
  blindCount: r.blind_count,
  flags: r.flags,
  openedAt: iso(r.opened_at),
  closedAt: r.closed_at === null ? null : iso(r.closed_at),
  zReport: r.z_report,
});

export async function listShifts(
  tx: TxHandle,
  tenantId: string,
  scope: BranchScope,
  q: z.output<typeof ShiftsQuerySchema>,
) {
  const limit = q.limit ?? 50;
  const w = where(tenantId, scope);
  if (q.branchId !== undefined) w.add("branch_id = ?", q.branchId);
  if (q.terminalId !== undefined) w.add("terminal_id = ?", q.terminalId);
  if (q.status !== undefined) w.add("status = ?", q.status);
  if (q.from !== undefined) w.add("business_date >= ?::date", q.from);
  if (q.to !== undefined) w.add("business_date <= ?::date", q.to);
  if (q.after !== undefined) {
    const [d, id] = q.after.split("|");
    w.params.push(d, id);
    w.sql.push(
      `(business_date, id) < ($${String(w.params.length - 1)}::date, $${String(w.params.length)}::uuid)`,
    );
  }
  w.params.push(limit + 1);
  const r = await tx.query<ShiftRow>(
    `select ${SHIFT_COLS} from sales.shifts where ${w.sql.join(" and ")}
     order by business_date desc, id desc limit $${String(w.params.length)}`,
    w.params,
  );
  const items = r.rows.slice(0, limit).map(toShift);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      r.rows.length > limit && last !== undefined ? `${last.businessDate}|${last.id}` : null,
  };
}

export async function getShift(tx: TxHandle, tenantId: string, scope: BranchScope, id: string) {
  const w = where(tenantId, scope);
  w.add("id = ?", id);
  const r = await tx.query<ShiftRow>(
    `select ${SHIFT_COLS} from sales.shifts where ${w.sql.join(" and ")}`,
    w.params,
  );
  const row = r.rows[0];
  return row === undefined ? undefined : toShift(row);
}
