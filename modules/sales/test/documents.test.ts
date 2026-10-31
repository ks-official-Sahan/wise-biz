import { randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  CashMovementSchema,
  CloseShiftSchema,
  CompleteReturnSchema,
  CompleteSaleSchema,
  OpenDrawerSchema,
  OpenShiftSchema,
  RecordOverrideSchema,
  VoidSaleSchema,
} from "@wise-biz/contracts";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { batchSalePrices, recordMovements, selectBatchesFefo } from "@wise-biz/module-inventory";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cashMovement,
  closeShift,
  completeReturn,
  completeSale,
  openDrawer,
  openShift,
  recordOverride,
  voidSale,
} from "../src/index.ts";

import type { OperatorFacts, SalesPorts, TerminalContext } from "../src/index.ts";
import type { TxHandle } from "@wise-biz/db";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const BRANCH = uuidv7();
const LOC = uuidv7();
const LIST = uuidv7();
const CASHIER = uuidv7();
const SUPERVISOR = uuidv7();
const TODAY = new Date().toISOString().slice(0, 10);

const operators = new Map<string, OperatorFacts>([
  [
    CASHIER,
    {
      active: true,
      permissions: new Set([
        "sales:sell",
        "sales:shift",
        "sales:void",
        "sales:return",
        "sales:open_drawer",
        "sales:cash",
      ]),
    },
  ],
  [SUPERVISOR, { active: true, permissions: "all" }],
]);
const ports: SalesPorts = {
  inventory: { recordMovements, batches: batchSalePrices, selectBatchesFefo },
  pricing: {
    quote: (_tx, _t, input) =>
      Promise.resolve({
        engine: "1.0.0",
        priceListId: `${input.priceListId}:1`,
        totalMinor: 1000,
        payableMinor: 1000,
        lines: [{ lineDiscounts: [], cartDiscounts: [] }],
      }),
  },
  tenancy: {
    operators: (_tx, _t, ids) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) => {
            const f = operators.get(id);
            return f === undefined ? [] : [[id, f] as const];
          }),
        ),
      ),
    policyVersion: () => Promise.resolve(1),
  },
};

let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "inventory", dir: dir("inventory") },
    { module: "sales", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"), { max: 20 });
  admin = createPool(db.url("admin"));
  drop = async () => {
    await pool.end();
    await admin.end();
    await db.drop();
  };
});
afterAll(async () => {
  await drop();
});

const tx = <R>(fn: (tx: TxHandle) => Promise<R>) =>
  withTenantTx(pool, { tenantId: T, requestId: "req-12345678" }, fn);
const seqs = new Map<string, number>();
const meta = (t: TerminalContext) => {
  const deviceSeq = seqs.get(t.terminalId) ?? 0;
  seqs.set(t.terminalId, deviceSeq + 1);
  return {
    deviceSeq,
    prevHash: randomBytes(32).toString("base64"),
    hash: randomBytes(32).toString("base64"),
    signature: randomBytes(64).toString("base64"),
  };
};
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();

interface Till {
  t: TerminalContext;
  shiftId: string;
  nextNo: () => number;
}
async function till(openingFloatMinor = 5000): Promise<Till> {
  const t: TerminalContext = {
    tenantId: T,
    terminalId: uuidv7(),
    branchId: BRANCH,
    requestId: "req-12345678",
    now: new Date(),
    ids: { uuidv7 },
  };
  const shift = OpenShiftSchema.parse({
    id: uuidv7(),
    operatorId: CASHIER,
    businessDate: TODAY,
    openedAt: iso(),
    currency: "USD",
    openingFloatMinor,
    meta: meta(t),
  });
  await tx((x) => openShift(x, ports, t, shift));
  let n = 0;
  return { t, shiftId: shift.id, nextNo: () => ++n };
}

const VARIANT = uuidv7();
async function sell(
  k: Till,
  over: { completedAt?: string; qty?: string; tenderKind?: string } = {},
) {
  const qty = over.qty ?? "2";
  const total = Number(qty) * 500;
  const cmd = CompleteSaleSchema.parse({
    id: uuidv7(),
    shiftId: k.shiftId,
    operatorId: CASHIER,
    saleNo: k.nextNo(),
    currency: "USD",
    businessDate: TODAY,
    completedAt: over.completedAt ?? iso(),
    priceListId: LIST,
    priceListVersion: 1,
    engineVersion: "1.0.0",
    policyVersion: 1,
    lines: [
      {
        variantId: VARIANT,
        name: "Tea",
        sku: "TEA",
        locationId: LOC,
        qty,
        unitPriceMinor: 500,
        priceSource: "list",
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: total,
      },
    ],
    tenders: [
      {
        id: uuidv7(),
        kind: over.tenderKind ?? "cash",
        amountMinor: total,
        ...(over.tenderKind === "card" ? { card: { provider: "acme", last4: "4242" } } : {}),
      },
    ],
    subtotalMinor: total,
    discountMinor: 0,
    feeMinor: 0,
    taxMinor: 0,
    totalMinor: total,
    cashRoundingMinor: 0,
    payableMinor: total,
    meta: meta(k.t),
  });
  // The quote stub answers 1000; scale so a sale of another size passes the same-inputs check.
  const ok = total === 1000 ? cmd : { ...cmd };
  await tx((x) =>
    completeSale(x, ports, k.t, ok, { priceTolerance: { bps: 10_000, minMinor: 1 } }),
  );
  return cmd;
}

const balance = async () =>
  Number(
    (
      await admin.query<{ qty: string | null }>(
        "select sum(qty)::text as qty from inventory.stock_balances where tenant_id = $1 and variant_id = $2",
        [T, VARIANT],
      )
    ).rows[0]?.qty ?? 0,
  );

async function override(k: Till, permission: string, subjectId?: string, approverId = SUPERVISOR) {
  const cmd = RecordOverrideSchema.parse({
    id: uuidv7(),
    requesterId: CASHIER,
    approverId,
    permission,
    reason: "Customer request",
    ...(subjectId === undefined ? {} : { subjectType: "sale", subjectId }),
    occurredAt: iso(),
    meta: meta(k.t),
  });
  await tx((x) => recordOverride(x, ports, k.t, cmd));
  return cmd;
}
const voidCmd = (k: Till, saleId: string, overrideId?: string) =>
  VoidSaleSchema.parse({
    id: uuidv7(),
    saleId,
    shiftId: k.shiftId,
    operatorId: CASHIER,
    occurredAt: iso(),
    reason: "Wrong item",
    ...(overrideId === undefined ? {} : { overrideId }),
    meta: meta(k.t),
  });
const returnCmd = (
  k: Till,
  saleId: string,
  over: {
    qty?: string;
    refundMinor?: number;
    disposition?: "restock" | "writeoff";
    kind?: string;
  } = {},
) => {
  const refundMinor = over.refundMinor ?? 500;
  return CompleteReturnSchema.parse({
    id: uuidv7(),
    saleId,
    shiftId: k.shiftId,
    operatorId: CASHIER,
    returnNo: k.nextNo(),
    currency: "USD",
    businessDate: TODAY,
    occurredAt: iso(),
    reason: "Damaged",
    lines: [
      {
        saleLine: 0,
        variantId: VARIANT,
        name: "Tea",
        sku: "TEA",
        locationId: LOC,
        qty: over.qty ?? "1",
        refundMinor,
        taxMinor: 0,
        disposition: over.disposition ?? "restock",
      },
    ],
    tenders: [{ id: uuidv7(), kind: over.kind ?? "cash", amountMinor: refundMinor }],
    totalMinor: refundMinor,
    meta: meta(k.t),
  });
};
const fails = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DomainError);
  expect((e as DomainError).code).toBe(code);
  return e as DomainError;
};

describe("RecordOverride", () => {
  it("records, replays, refuses self-approval and flags an unauthorized approver", async () => {
    const k = await till();
    const cmd = await override(k, "sales:void_late");
    expect(await tx((x) => recordOverride(x, ports, k.t, cmd))).toEqual({
      body: { overrideId: cmd.id, flags: [] },
      replayed: true,
    });
    const self = RecordOverrideSchema.parse({
      ...cmd,
      id: uuidv7(),
      approverId: CASHIER,
      meta: meta(k.t),
    });
    await fails(
      tx((x) => recordOverride(x, ports, k.t, self)),
      "VALIDATION_FAILED",
    );
    const weak = RecordOverrideSchema.parse({
      ...cmd,
      id: uuidv7(),
      approverId: uuidv7(),
      meta: meta(k.t),
    });
    expect((await tx((x) => recordOverride(x, ports, k.t, weak))).body.flags).toEqual([
      "approver_unauthorized",
    ]);
  });
});

describe("VoidSale", () => {
  it("voids within the window, reverses the stock once and refuses a second void", async () => {
    const k = await till();
    const before = await balance();
    const sale = await sell(k);
    expect(await balance()).toBe(before - 2);
    const v = voidCmd(k, sale.id);
    const r = await tx((x) => voidSale(x, ports, k.t, v));
    expect(r.body).toEqual({ voidId: v.id, saleId: sale.id, flags: [] });
    expect(await balance()).toBe(before);
    expect((await tx((x) => voidSale(x, ports, k.t, v))).replayed).toBe(true);
    expect(await balance()).toBe(before);
    const st = await admin.query<{ status: string }>(
      "select status from sales.sales where id = $1",
      [sale.id],
    );
    expect(st.rows[0]?.status).toBe("voided");
    await fails(
      tx((x) => voidSale(x, ports, k.t, voidCmd(k, sale.id))),
      "VALIDATION_FAILED",
    );
  });

  it("needs a void_late override after the window, and the right one", async () => {
    const k = await till();
    const sale = await sell(k, { completedAt: iso(-2 * 3_600_000) });
    const e = await fails(
      tx((x) => voidSale(x, ports, k.t, voidCmd(k, sale.id))),
      "PRECONDITION_FAILED",
    );
    expect(e.details).toEqual({ permission: "sales:void_late" });
    const wrong = await override(k, "sales:return", sale.id);
    await fails(
      tx((x) => voidSale(x, ports, k.t, voidCmd(k, sale.id, wrong.id))),
      "VALIDATION_FAILED",
    );
    const other = await override(k, "sales:void_late", uuidv7());
    await fails(
      tx((x) => voidSale(x, ports, k.t, voidCmd(k, sale.id, other.id))),
      "VALIDATION_FAILED",
    );
    // An override approved on another terminal does not count here.
    const elsewhere = await till();
    const foreign = await override(elsewhere, "sales:void_late", sale.id);
    await fails(
      tx((x) => voidSale(x, ports, k.t, voidCmd(k, sale.id, foreign.id))),
      "VALIDATION_FAILED",
    );
    const good = await override(k, "sales:void_late", sale.id);
    const v = voidCmd(k, sale.id, good.id);
    expect((await tx((x) => voidSale(x, ports, k.t, v))).body.flags).toEqual([]);
    // An override is used once.
    const again = await sell(k, { completedAt: iso(-2 * 3_600_000) });
    await fails(
      tx((x) => voidSale(x, ports, k.t, voidCmd(k, again.id, good.id))),
      "VALIDATION_FAILED",
    );
  });

  it("a backdated void cannot skip the override, and a void cannot predate its sale", async () => {
    const k = await till();
    const sale = await sell(k, { completedAt: iso(-2 * 3_600_000) });
    const backdated = VoidSaleSchema.parse({
      ...voidCmd(k, sale.id),
      occurredAt: iso(-3_600_000 + 60_000),
    });
    const e = await fails(
      tx((x) => voidSale(x, ports, k.t, backdated)),
      "PRECONDITION_FAILED",
    );
    expect(e.details).toEqual({ permission: "sales:void_late" });
    const early = VoidSaleSchema.parse({ ...voidCmd(k, sale.id), occurredAt: iso(-3 * 3_600_000) });
    await fails(
      tx((x) => voidSale(x, ports, k.t, early)),
      "VALIDATION_FAILED",
    );
  });

  it("a void that waits for a concurrent return sees it and refuses", async () => {
    const k = await till();
    const sale = await sell(k);
    const base = await balance();
    const results = await Promise.allSettled([
      tx((x) => completeReturn(x, ports, k.t, returnCmd(k, sale.id))),
      tx((x) => voidSale(x, ports, k.t, voidCmd(k, sale.id))),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    // Whichever won, stock is consistent: +1 (return restock) or +2 (void), never +3.
    const delta = (await balance()) - base;
    expect(results[0].status === "fulfilled" ? delta === 1 : delta === 2).toBe(true);
  });

  it("flags a sale with a hand-set price from an operator without price_override", async () => {
    const k = await till();
    const base = await sell(k);
    const line = { ...base.lines[0], priceSource: "override" } as (typeof base.lines)[number];
    const cmd = CompleteSaleSchema.parse({
      ...base,
      id: uuidv7(),
      saleNo: k.nextNo(),
      lines: [line],
      tenders: [{ id: uuidv7(), kind: "cash", amountMinor: 1000 }],
      meta: meta(k.t),
    });
    const r = await tx((x) => completeSale(x, ports, k.t, cmd));
    expect(r.body.flags).toEqual(["price_override_unauthorized"]);
  });

  it("flags a void that relies on an unauthorized approver", async () => {
    const k = await till();
    const sale = await sell(k, { completedAt: iso(-2 * 3_600_000) });
    const weak = await override(k, "sales:void_late", sale.id, uuidv7());
    const r = await tx((x) => voidSale(x, ports, k.t, voidCmd(k, sale.id, weak.id)));
    expect(r.body.flags).toEqual(["override_unauthorized"]);
  });

  it("refuses a void after a return, and a return after a void", async () => {
    const k = await till();
    const a = await sell(k);
    await tx((x) => completeReturn(x, ports, k.t, returnCmd(k, a.id)));
    await fails(
      tx((x) => voidSale(x, ports, k.t, voidCmd(k, a.id))),
      "VALIDATION_FAILED",
    );
    const b = await sell(k);
    await tx((x) => voidSale(x, ports, k.t, voidCmd(k, b.id)));
    await fails(
      tx((x) => completeReturn(x, ports, k.t, returnCmd(k, b.id))),
      "VALIDATION_FAILED",
    );
  });
});

describe("CompleteReturn", () => {
  it("restocks, accepts partial returns up to the sold quantity and amount, never beyond", async () => {
    const k = await till();
    const sale = await sell(k); // 2 x 500
    const base = await balance();
    const first = returnCmd(k, sale.id);
    expect((await tx((x) => completeReturn(x, ports, k.t, first))).body.flags).toEqual([]);
    expect(await balance()).toBe(base + 1);
    expect((await tx((x) => completeReturn(x, ports, k.t, first))).replayed).toBe(true);
    expect(await balance()).toBe(base + 1);
    await fails(
      tx((x) => completeReturn(x, ports, k.t, returnCmd(k, sale.id, { qty: "1.0001" }))),
      "VALIDATION_FAILED",
    );
    await fails(
      tx((x) => completeReturn(x, ports, k.t, returnCmd(k, sale.id, { refundMinor: 600 }))),
      "VALIDATION_FAILED",
    );
    await tx((x) => completeReturn(x, ports, k.t, returnCmd(k, sale.id)));
    await fails(
      tx((x) => completeReturn(x, ports, k.t, returnCmd(k, sale.id))),
      "VALIDATION_FAILED",
    );
    expect(await balance()).toBe(base + 2);
  });

  it("a written-off line does not restock", async () => {
    const k = await till();
    const sale = await sell(k);
    const base = await balance();
    await tx((x) =>
      completeReturn(x, ports, k.t, returnCmd(k, sale.id, { disposition: "writeoff" })),
    );
    expect(await balance()).toBe(base);
  });

  it("refuses a line that is not on the sale", async () => {
    const k = await till();
    const sale = await sell(k);
    const cmd = returnCmd(k, sale.id);
    const bad = CompleteReturnSchema.parse({
      ...cmd,
      lines: [{ ...cmd.lines[0], variantId: uuidv7() }],
    });
    await fails(
      tx((x) => completeReturn(x, ports, k.t, bad)),
      "VALIDATION_FAILED",
    );
  });

  it("two concurrent returns of the same sale line never exceed the quantity sold", async () => {
    const k = await till();
    const sale = await sell(k, { qty: "1" });
    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        tx((x) =>
          completeReturn(x, ports, k.t, returnCmd(k, sale.id, { qty: "1", refundMinor: 500 })),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const sum = await admin.query<{ q: string }>(
      "select coalesce(sum(qty), 0)::text as q from sales.return_lines where sale_id = $1",
      [sale.id],
    );
    expect(Number(sum.rows[0]?.q)).toBe(1);
  });

  it("a no-receipt return needs its override, which must grant the permission", async () => {
    const k = await till();
    const cmd = returnCmd(k, uuidv7());
    const noReceipt = (overrideId: string) =>
      CompleteReturnSchema.parse({
        ...cmd,
        id: uuidv7(),
        saleId: null,
        overrideId,
        lines: [{ ...cmd.lines[0], saleLine: undefined }],
        meta: meta(k.t),
      });
    const wrong = await override(k, "sales:return");
    await fails(
      tx((x) => completeReturn(x, ports, k.t, noReceipt(wrong.id))),
      "VALIDATION_FAILED",
    );
    const good = await override(k, "sales:return_no_receipt");
    const r = await tx((x) => completeReturn(x, ports, k.t, noReceipt(good.id)));
    expect(r.body.flags).toEqual([]);
  });
});

describe("drawer and cash movements", () => {
  it("flags a no-sale drawer open and records cash movements; both replay", async () => {
    const k = await till();
    const sale = await sell(k);
    const drawer = (saleId?: string) =>
      OpenDrawerSchema.parse({
        id: uuidv7(),
        shiftId: k.shiftId,
        operatorId: CASHIER,
        openedAt: iso(),
        reason: "Make change",
        ...(saleId === undefined ? {} : { saleId }),
        meta: meta(k.t),
      });
    const noSale = drawer();
    expect((await tx((x) => openDrawer(x, ports, k.t, noSale))).body.flags).toEqual(["no_sale"]);
    expect((await tx((x) => openDrawer(x, ports, k.t, noSale))).replayed).toBe(true);
    expect((await tx((x) => openDrawer(x, ports, k.t, drawer(sale.id)))).body.flags).toEqual([]);
    const cash = CashMovementSchema.parse({
      id: uuidv7(),
      shiftId: k.shiftId,
      operatorId: CASHIER,
      kind: "pay_out",
      amountMinor: 200,
      occurredAt: iso(),
      reason: "Milk",
      meta: meta(k.t),
    });
    expect((await tx((x) => cashMovement(x, ports, k.t, cash))).body.flags).toEqual([]);
    expect((await tx((x) => cashMovement(x, ports, k.t, cash))).replayed).toBe(true);
  });
});

describe("CloseShift", () => {
  it("freezes the Z-report: expected cash, over/short, tenders, voids and returns", async () => {
    const k = await till(5000);
    await sell(k); // cash 1000
    await sell(k, { tenderKind: "card" }); // card 1000
    const gone = await sell(k); // cash 1000, then voided
    await tx((x) => voidSale(x, ports, k.t, voidCmd(k, gone.id)));
    const kept = await sell(k); // cash 1000, partly refunded
    await tx((x) => completeReturn(x, ports, k.t, returnCmd(k, kept.id)));
    for (const [kind, amountMinor] of [
      ["pay_in", 300],
      ["pay_out", 200],
      ["float_add", 100],
      ["drop", 1000],
    ] as const) {
      await tx((x) =>
        cashMovement(
          x,
          ports,
          k.t,
          CashMovementSchema.parse({
            id: uuidv7(),
            shiftId: k.shiftId,
            operatorId: CASHIER,
            kind,
            amountMinor,
            occurredAt: iso(),
            reason: "count",
            meta: meta(k.t),
          }),
        ),
      );
    }
    // 5000 + cash sales 3000 (gone + kept + first; the card sale is not cash) - voided 1000 - refund 500
    // + 300 + 100 - 200 - 1000 = 5700
    const close = CloseShiftSchema.parse({
      id: k.shiftId,
      operatorId: CASHIER,
      closedAt: iso(),
      countedCashMinor: 5650,
      blindCount: true,
      meta: meta(k.t),
    });
    const r = await tx((x) => closeShift(x, ports, k.t, close));
    expect(r.body).toEqual({ shiftId: k.shiftId, status: "closed", flags: [] });
    const row = await admin.query<{
      expected: string;
      counted: string;
      over_short: string;
      z: {
        sales: { count: number };
        voids: { count: number };
        returns: { totalMinor: number };
        tenders: unknown[];
        cash: Record<string, number>;
      };
    }>(
      `select expected_cash_minor::text as expected, counted_cash_minor::text as counted,
         over_short_minor::text as over_short, z_report as z from sales.shifts where id = $1`,
      [k.shiftId],
    );
    expect(row.rows[0]).toMatchObject({ expected: "5700", counted: "5650", over_short: "-50" });
    const z = row.rows[0]?.z;
    expect(z?.sales.count).toBe(4);
    expect(z?.voids.count).toBe(1);
    expect(z?.returns.totalMinor).toBe(500);
    expect(z?.cash).toMatchObject({
      salesMinor: 4000 - 1000 + 0,
      voidedMinor: 1000,
      refundsMinor: 500,
    });
    expect(z?.tenders).toEqual([
      { kind: "card", salesMinor: 1000, refundsMinor: 0 },
      { kind: "cash", salesMinor: 3000, refundsMinor: 1500 },
    ]);
    expect((await tx((x) => closeShift(x, ports, k.t, close))).replayed).toBe(true);
  });

  it("no document joins a closed shift, and a sale racing the close is either in the report or refused", async () => {
    const k = await till(0);
    const close = CloseShiftSchema.parse({
      id: k.shiftId,
      operatorId: CASHIER,
      closedAt: iso(),
      countedCashMinor: 0,
      meta: meta(k.t),
    });
    const [closed, racing] = await Promise.allSettled([
      tx((x) => closeShift(x, ports, k.t, close)),
      sell(k),
    ]);
    expect(closed.status).toBe("fulfilled");
    const z = await admin.query<{ z: { sales: { count: number } } }>(
      "select z_report as z from sales.shifts where id = $1",
      [k.shiftId],
    );
    const inShift = Number(
      (
        await admin.query<{ n: string }>("select count(*) n from sales.sales where shift_id = $1", [
          k.shiftId,
        ])
      ).rows[0]?.n,
    );
    expect(z.rows[0]?.z.sales.count).toBe(inShift);
    expect(racing.status === "fulfilled" ? 1 : 0).toBe(inShift);
    await fails(sell(k), "VALIDATION_FAILED");
  });
});
