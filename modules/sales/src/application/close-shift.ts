import { ShiftClosedV1 } from "../events.ts";

import {
  commit,
  insertChain,
  lockOpenShift,
  one,
  operatorFlags,
  pgErrors,
  salesEvent,
  seen,
} from "./shared.ts";

import type { Applied } from "./sale.ts";
import type { ShiftReceipt } from "./shift.ts";
import type { ZReport } from "../events.ts";
import type { SalesPorts, TerminalContext } from "../ports.ts";
import type { CloseShift } from "@wise-biz/contracts";
import type { TxHandle } from "@wise-biz/db";

interface Totals {
  sales_count: string;
  sales_payable: string;
  sales_tax: string;
  sales_discount: string;
  voids_count: string;
  voids_payable: string;
  returns_count: string;
  returns_total: string;
  cash_sales: string;
  cash_voided: string;
  cash_refunds: string;
  pay_in: string;
  pay_out: string;
  float_add: string;
  drops: string;
  drawer_opens: string;
}

/**
 * Every figure of a shift, all index-backed by the shift id. Cash sales count the amount applied to the sale
 * (change is already out). A void in this shift hands the cash back from this drawer, even when the sale was rung in
 * an earlier shift.
 */
async function shiftTotals(tx: TxHandle, tenantId: string, shiftId: string) {
  const r = await tx.query<Totals>(
    `select
       (select count(*) from sales.sales where tenant_id = $1 and shift_id = $2) as sales_count,
       (select coalesce(sum(payable_minor), 0) from sales.sales where tenant_id = $1 and shift_id = $2) as sales_payable,
       (select coalesce(sum(tax_minor), 0) from sales.sales where tenant_id = $1 and shift_id = $2) as sales_tax,
       (select coalesce(sum(discount_minor), 0) from sales.sales where tenant_id = $1 and shift_id = $2) as sales_discount,
       (select count(*) from sales.voids where tenant_id = $1 and shift_id = $2) as voids_count,
       (select coalesce(sum(s.payable_minor), 0) from sales.voids v join sales.sales s
          on s.tenant_id = v.tenant_id and s.id = v.sale_id where v.tenant_id = $1 and v.shift_id = $2) as voids_payable,
       (select count(*) from sales.returns where tenant_id = $1 and shift_id = $2) as returns_count,
       (select coalesce(sum(total_minor), 0) from sales.returns where tenant_id = $1 and shift_id = $2) as returns_total,
       (select coalesce(sum(t.amount_minor), 0) from sales.sale_tenders t join sales.sales s
          on s.tenant_id = t.tenant_id and s.id = t.sale_id
          where t.tenant_id = $1 and s.shift_id = $2 and t.kind = 'cash') as cash_sales,
       (select coalesce(sum(t.amount_minor), 0) from sales.voids v join sales.sale_tenders t
          on t.tenant_id = v.tenant_id and t.sale_id = v.sale_id
          where v.tenant_id = $1 and v.shift_id = $2 and t.kind = 'cash') as cash_voided,
       (select coalesce(sum(t.amount_minor), 0) from sales.return_tenders t join sales.returns r
          on r.tenant_id = t.tenant_id and r.id = t.return_id
          where t.tenant_id = $1 and r.shift_id = $2 and t.kind = 'cash') as cash_refunds,
       (select coalesce(sum(amount_minor) filter (where kind = 'pay_in'), 0) from sales.cash_movements
          where tenant_id = $1 and shift_id = $2) as pay_in,
       (select coalesce(sum(amount_minor) filter (where kind = 'pay_out'), 0) from sales.cash_movements
          where tenant_id = $1 and shift_id = $2) as pay_out,
       (select coalesce(sum(amount_minor) filter (where kind = 'float_add'), 0) from sales.cash_movements
          where tenant_id = $1 and shift_id = $2) as float_add,
       (select coalesce(sum(amount_minor) filter (where kind = 'drop'), 0) from sales.cash_movements
          where tenant_id = $1 and shift_id = $2) as drops,
       (select count(*) from sales.drawer_sessions where tenant_id = $1 and shift_id = $2) as drawer_opens`,
    [tenantId, shiftId],
  );
  const tenders = await tx.query<{ kind: string; sales_minor: string; refunds_minor: string }>(
    `select kind, sum(sales_minor) as sales_minor, sum(refunds_minor) as refunds_minor from (
       select t.kind, t.amount_minor as sales_minor, 0 as refunds_minor
         from sales.sale_tenders t join sales.sales s on s.tenant_id = t.tenant_id and s.id = t.sale_id
         where t.tenant_id = $1 and s.shift_id = $2
       union all
       select t.kind, 0, t.amount_minor from sales.voids v join sales.sale_tenders t
         on t.tenant_id = v.tenant_id and t.sale_id = v.sale_id where v.tenant_id = $1 and v.shift_id = $2
       union all
       select t.kind, 0, t.amount_minor from sales.return_tenders t join sales.returns r
         on r.tenant_id = t.tenant_id and r.id = t.return_id where t.tenant_id = $1 and r.shift_id = $2
     ) x group by kind order by kind`,
    [tenantId, shiftId],
  );
  return { totals: one(r.rows), tenders: tenders.rows };
}

/**
 * CloseShift: freezes the shift's Z-report and compares the counted cash with the expected cash (opening float + cash
 * sales - cash voids - cash refunds + pay-ins + float top-ups - pay-outs - drops). A blind count hides the expected
 * amount on the terminal only; the server always computes it. The shift row is locked FOR UPDATE, so documents
 * committing beside the close finish first and none joins a closed shift.
 */
export async function closeShift(
  tx: TxHandle,
  ports: SalesPorts,
  t: TerminalContext,
  cmd: CloseShift,
): Promise<Applied<ShiftReceipt>> {
  if (await seen(tx, t, "shift_close", cmd.id, cmd.meta)) {
    const r = await tx.query<{ flags: string[] }>(
      "select flags from sales.shifts where tenant_id = $1 and id = $2",
      [t.tenantId, cmd.id],
    );
    return {
      body: { shiftId: cmd.id, status: "closed", flags: one(r.rows).flags },
      replayed: true,
    };
  }
  const shift = await lockOpenShift(tx, t, cmd.id, "update");
  const flags = (await operatorFlags(tx, ports.tenancy, t, cmd.operatorId, "sales:shift")).sort();
  const { totals: x, tenders } = await shiftTotals(tx, t.tenantId, cmd.id);
  const n = Number;
  const opening = n(shift.opening_float_minor);
  const expected =
    opening +
    n(x.cash_sales) -
    n(x.cash_voided) -
    n(x.cash_refunds) +
    n(x.pay_in) +
    n(x.float_add) -
    n(x.pay_out) -
    n(x.drops);
  const overShort = cmd.countedCashMinor - expected;
  const zReport: ZReport = {
    sales: {
      count: n(x.sales_count),
      payableMinor: n(x.sales_payable),
      taxMinor: n(x.sales_tax),
      discountMinor: n(x.sales_discount),
    },
    voids: { count: n(x.voids_count), payableMinor: n(x.voids_payable) },
    returns: { count: n(x.returns_count), totalMinor: n(x.returns_total) },
    tenders: tenders.map((r) => ({
      kind: r.kind,
      salesMinor: n(r.sales_minor),
      refundsMinor: n(r.refunds_minor),
    })),
    cash: {
      openingFloatMinor: opening,
      salesMinor: n(x.cash_sales),
      refundsMinor: n(x.cash_refunds),
      voidedMinor: n(x.cash_voided),
      payInMinor: n(x.pay_in),
      payOutMinor: n(x.pay_out),
      floatAddMinor: n(x.float_add),
      dropsMinor: n(x.drops),
      expectedMinor: expected,
      countedMinor: cmd.countedCashMinor,
      overShortMinor: overShort,
    },
    drawerOpens: n(x.drawer_opens),
  };
  const closedAt = new Date(cmd.closedAt);
  return pgErrors(async () => {
    await insertChain(tx, t, "shift_close", cmd.id, cmd.meta);
    const info = await tx.query<{ business_date: string; flags: string[] }>(
      `update sales.shifts set status = 'closed', closed_by = $3, closed_at = $4, expected_cash_minor = $5,
         counted_cash_minor = $6, over_short_minor = $7, blind_count = $8, note = $9, z_report = $10,
         flags = (select array(select distinct f from unnest(flags || $11::text[]) f order by f))
       where tenant_id = $1 and id = $2 returning business_date::text, flags`,
      [
        t.tenantId,
        cmd.id,
        cmd.operatorId,
        closedAt,
        expected,
        cmd.countedCashMinor,
        overShort,
        cmd.blindCount,
        cmd.note ?? null,
        JSON.stringify(zReport),
        flags,
      ],
    );
    const row = one(info.rows);
    await commit(
      tx,
      t,
      {
        action: "sales.shift.close",
        entity: "shift",
        entityId: cmd.id,
        before: { status: "open" },
        after: {
          status: "closed",
          operatorId: cmd.operatorId,
          expectedCashMinor: expected,
          countedCashMinor: cmd.countedCashMinor,
          overShortMinor: overShort,
          blindCount: cmd.blindCount,
        },
        ...(cmd.note === undefined ? {} : { reason: cmd.note }),
      },
      [
        salesEvent(ShiftClosedV1, t, `shift/${cmd.id}`, {
          shiftId: cmd.id,
          branchId: t.branchId,
          terminalId: t.terminalId,
          operatorId: cmd.operatorId,
          businessDate: row.business_date,
          currency: shift.currency,
          closedAt: closedAt.toISOString(),
          blindCount: cmd.blindCount,
          flags: row.flags,
          zReport,
        }),
      ],
    );
    return {
      body: { shiftId: cmd.id, status: "closed" as const, flags: row.flags },
      replayed: false,
    };
  });
}
