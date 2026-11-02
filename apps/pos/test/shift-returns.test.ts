import {
  CashMovementSchema,
  CloseShiftSchema,
  CompleteReturnSchema,
  OpenShiftSchema,
  RecordOverrideSchema,
  VoidSaleSchema,
} from "@wise-biz/contracts";
import { uuidv7 } from "@wise-biz/ids";
import { describe, expect, it } from "vitest";

import {
  commitReturn,
  recentSales,
  refundFor,
  returnableLines,
  saleById,
} from "../src/features/returns/model/returns.ts";
import {
  closeShift,
  currentShift,
  openShift,
  recordCashMovement,
  zReport,
} from "../src/features/shift/model/shift.ts";
import { commitSale } from "../src/features/tender/model/commit.ts";
import { VOID_WINDOW_MS, voidNeedsOverride, voidSale } from "../src/features/void/model/void.ts";

import { ids, linesOf, setup } from "./support/pos-fixture.ts";

type Fx = Awaited<ReturnType<typeof setup>>;

const shiftDeps = (fx: Fx) => ({
  transaction: fx.deps.transaction,
  now: fx.deps.now,
  newId: uuidv7,
  operatorId: ids.operator,
});
const returnDeps = (fx: Fx, has = true) => ({
  ...shiftDeps(fx),
  locationOf: fx.deps.locationOf,
  has: () => has,
});
const voidDeps = (fx: Fx, has = true) => ({ ...shiftDeps(fx), has: () => has });

/** Rings up 2 x tea + 1 x rice paid in cash (total 19.85). */
async function sell(fx: Fx) {
  await fx.model.addVariant(ids.tea, "2");
  await fx.model.addVariant(ids.rice, "1");
  const pricing = fx.model.pricing()!;
  const sale = await commitSale(fx.deps, {
    pricing,
    cart: linesOf(fx.store),
    tenders: [{ id: uuidv7(), kind: "cash", amountMinor: pricing.totals.totalMinor }],
    customerId: null,
    approvals: [],
  });
  await fx.model.finish();
  return sale;
}

const bodies = async (fx: Fx, type: string) =>
  (await fx.outbox.allPending()).filter((p) => p.command.type === type).map((p) => p.command.body);
const types = async (fx: Fx) => (await fx.outbox.allPending()).map((p) => p.command.type);
const lineOf = (sale: { lines: readonly { variantId: string }[] }, variantId: string) =>
  sale.lines.findIndex((l) => l.variantId === variantId);

describe("shift", () => {
  it("opens once, tracks cash movements, closes with over/short", async () => {
    const fx = await setup();
    const s = await openShift(shiftDeps(fx), { floatMinor: 5000, currency: "USD" });
    expect((await openShift(shiftDeps(fx), { floatMinor: 9999, currency: "USD" })).id).toBe(s.id);
    expect(OpenShiftSchema.safeParse((await bodies(fx, "open_shift"))[0]).success).toBe(true);

    const sale = await sell(fx);
    expect(sale.shiftId).toBe(s.id);
    const move = (
      kind: "pay_in" | "pay_out" | "float_add" | "drop",
      amountMinor: number,
      reason: string,
    ) => recordCashMovement(shiftDeps(fx), { kind, amountMinor, reason });
    await move("pay_out", 500, " milk ");
    await move("pay_in", 100, "bank");
    await move("drop", 1000, "safe");
    await move("float_add", 200, "coins");
    for (const b of await bodies(fx, "cash_movement"))
      expect(CashMovementSchema.safeParse(b).success).toBe(true);

    const z = await zReport(fx.db, s.id);
    expect(z).toMatchObject({
      salesCount: 1,
      salesMinor: 1985,
      cashSalesMinor: 1985,
      payOutMinor: 500,
      payInMinor: 100,
      dropsMinor: 1000,
      floatAddedMinor: 200,
      expectedCashMinor: 5000 + 1985 + 100 + 200 - 500 - 1000,
    });

    const closed = await closeShift(shiftDeps(fx), {
      countedMinor: 5780,
      blind: true,
      note: " short ",
    });
    expect(closed.varianceMinor).toBe(-5);
    const close = (await bodies(fx, "close_shift"))[0];
    expect(CloseShiftSchema.safeParse(close).success).toBe(true);
    expect(close).toMatchObject({
      id: s.id,
      countedCashMinor: 5780,
      blindCount: true,
      note: "short",
    });
    expect(await currentShift(fx.db)).toBeUndefined();
  });

  it("refuses bad input", async () => {
    const fx = await setup();
    const move = (amountMinor: number, reason: string) =>
      recordCashMovement(shiftDeps(fx), { kind: "pay_in", amountMinor, reason });
    await expect(move(100, "x")).rejects.toMatchObject({ code: "no_shift" });
    await openShift(shiftDeps(fx), { floatMinor: 0, currency: "USD" });
    await expect(move(0, "x")).rejects.toMatchObject({ code: "bad_amount" });
    await expect(move(1.5, "x")).rejects.toMatchObject({ code: "bad_amount" });
    await expect(move(5, "  ")).rejects.toMatchObject({ code: "reason_required" });
    await expect(
      openShift(shiftDeps(fx), { floatMinor: -1, currency: "USD" }),
    ).rejects.toMatchObject({
      code: "bad_amount",
    });
    await expect(
      closeShift(shiftDeps(fx), { countedMinor: -1, blind: false }),
    ).rejects.toMatchObject({
      code: "bad_amount",
    });
    await expect(zReport(fx.db, "nope")).rejects.toMatchObject({ code: "no_shift" });
    await closeShift(shiftDeps(fx), { countedMinor: 0, blind: false });
    await expect(
      closeShift(shiftDeps(fx), { countedMinor: 0, blind: false }),
    ).rejects.toMatchObject({
      code: "no_shift",
    });
  });

  it("auto-closes yesterday's shift on the first sale of a new business day", async () => {
    const fx = await setup();
    const a = await sell(fx);
    fx.clock.t += 36 * 3_600_000;
    const b = await sell(fx);
    expect(b.shiftId).not.toBe(a.shiftId);
    const old = await fx.db.get<{ closed_at: number | null; auto_closed: number }>(
      "SELECT closed_at, auto_closed FROM local_shifts WHERE id = ?",
      [a.shiftId],
    );
    expect(old?.auto_closed).toBe(1);
    expect(old?.closed_at).not.toBeNull();
    expect((await currentShift(fx.db))?.id).toBe(b.shiftId);
  });
});

describe("returns", () => {
  it("returns in parts and refunds exactly what the line was paid", async () => {
    const fx = await setup();
    const sale = await sell(fx);
    const stored = (await saleById(fx.db, sale.saleId))!;
    const tea = lineOf(stored, ids.tea);
    const teaTotal = stored.lines[tea]!.totalMinor;
    const first = await commitReturn(returnDeps(fx), {
      sale: stored,
      lines: [{ saleLine: tea, qty: "1", disposition: "restock" }],
      reason: "wrong flavour",
    });
    expect((await returnableLines(fx.db, stored)).find((l) => l.saleLine === tea)?.qtyLeft).toBe(
      "1",
    );
    const second = await commitReturn(returnDeps(fx), {
      sale: stored,
      lines: [{ saleLine: tea, qty: "1", disposition: "writeoff" }],
      reason: "damaged",
    });
    expect(first.totalMinor + second.totalMinor).toBe(teaTotal);
    expect([first.returnNo, second.returnNo]).toEqual([1, 2]);
    for (const b of await bodies(fx, "complete_return")) {
      const r = CompleteReturnSchema.safeParse(b);
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    }
    const restocked = await fx.db.all("SELECT * FROM local_movements WHERE ref_id = ?", [
      first.returnId,
    ]);
    const written = await fx.db.all("SELECT * FROM local_movements WHERE ref_id = ?", [
      second.returnId,
    ]);
    expect(restocked).toHaveLength(1);
    expect(written).toHaveLength(0);
    const z = await zReport(fx.db, sale.shiftId);
    expect(z).toMatchObject({
      returnsCount: 2,
      returnsMinor: teaTotal,
      cashRefundsMinor: teaTotal,
    });
  });

  it("blocks over-returns", async () => {
    const fx = await setup();
    const sale = await sell(fx);
    const stored = (await saleById(fx.db, sale.saleId))!;
    const rice = lineOf(stored, ids.rice);
    const ret = (qty: string, saleLine = rice) =>
      commitReturn(returnDeps(fx), {
        sale: stored,
        lines: [{ saleLine, qty, disposition: "restock" }],
        reason: "x",
      });
    await expect(ret("2")).rejects.toMatchObject({ code: "over_return" });
    await ret("1");
    await expect(ret("1")).rejects.toMatchObject({ code: "over_return" });
    await expect(ret("1", 99)).rejects.toMatchObject({ code: "over_return" });
    expect(await bodies(fx, "complete_return")).toHaveLength(1);
  });

  it("needs reason, lines, a known sale, and permission or approval", async () => {
    const fx = await setup();
    const sale = await sell(fx);
    const stored = (await saleById(fx.db, sale.saleId))!;
    const line = { saleLine: 0, qty: "1", disposition: "restock" as const };
    await expect(
      commitReturn(returnDeps(fx), { sale: stored, lines: [line], reason: " " }),
    ).rejects.toMatchObject({
      code: "reason_required",
    });
    await expect(
      commitReturn(returnDeps(fx), { sale: stored, lines: [], reason: "x" }),
    ).rejects.toMatchObject({
      code: "nothing",
    });
    await expect(
      commitReturn(returnDeps(fx, false), { sale: stored, lines: [line], reason: "x" }),
    ).rejects.toMatchObject({ code: "needs_override" });
    await expect(
      commitReturn(returnDeps(fx), {
        sale: { ...stored, id: uuidv7() },
        lines: [line],
        reason: "x",
      }),
    ).rejects.toMatchObject({ code: "no_sale" });
    const approval = {
      id: uuidv7(),
      permission: "sales:return",
      approverId: uuidv7(),
      requesterId: ids.operator,
      reason: "manager ok",
      subjectId: "s",
      at: fx.clock.t,
    };
    await commitReturn(returnDeps(fx, false), {
      sale: stored,
      lines: [line],
      reason: "x",
      approval,
    });
    expect((await types(fx)).slice(-2)).toEqual(["record_override", "complete_return"]);
    expect(
      RecordOverrideSchema.safeParse((await bodies(fx, "record_override")).at(-1)).success,
    ).toBe(true);
    expect((await bodies(fx, "complete_return"))[0]).toMatchObject({ overrideId: approval.id });
  });

  it("splits a refund between the original card and cash", async () => {
    const fx = await setup();
    const sale = await sell(fx);
    const stored = (await saleById(fx.db, sale.saleId))!;
    const out = await commitReturn(returnDeps(fx), {
      sale: stored,
      lines: [{ saleLine: 0, qty: "1", disposition: "restock" }],
      reason: "x",
      cardRefunds: [{ tenderId: "t", amountMinor: 100, providerRef: "mock_1", last4: "4242" }],
    });
    expect(out.cashMinor).toBe(out.totalMinor - 100);
    const body = (await bodies(fx, "complete_return"))[0] as unknown as {
      tenders: { kind: string }[];
    };
    expect(body.tenders.map((t) => t.kind)).toEqual(["card", "cash"]);
    expect(CompleteReturnSchema.safeParse(body).success).toBe(true);
    await expect(
      commitReturn(returnDeps(fx), {
        sale: stored,
        lines: [{ saleLine: 1, qty: "1", disposition: "restock" }],
        reason: "x",
        cardRefunds: [{ tenderId: "t", amountMinor: 999_999, providerRef: "m" }],
      }),
    ).rejects.toMatchObject({ code: "over_return" });
  });

  it("lists recent sales, filters by number, forgets old ones", async () => {
    const fx = await setup();
    await sell(fx);
    fx.clock.t += 1000;
    await sell(fx);
    const now = fx.clock.t;
    expect((await recentSales(fx.db, { now })).map((s) => s.saleNo)).toEqual([2, 1]);
    expect((await recentSales(fx.db, { now, saleNo: 1 })).map((s) => s.saleNo)).toEqual([1]);
    expect(await recentSales(fx.db, { now, saleNo: 9 })).toEqual([]);
    expect(await recentSales(fx.db, { now: now + 40 * 24 * 3_600_000 })).toEqual([]);
  });

  it("refund shares add up to the line total", () => {
    const line = {
      variantId: "v",
      name: "n",
      sku: "s",
      locationId: "l",
      qty: "3",
      unitPriceMinor: 333,
      discountMinor: 0,
      taxMinor: 100,
      totalMinor: 1099,
    };
    const a = refundFor(line, "3", "1", 0);
    const b = refundFor(line, "2", "1", a.refundMinor);
    const c = refundFor(line, "1", "1", a.refundMinor + b.refundMinor);
    expect(a.refundMinor + b.refundMinor + c.refundMinor).toBe(1099);
    expect(refundFor(line, "3", "4", 0)).toEqual({ refundMinor: 0, taxMinor: 0 });
    expect(refundFor(line, "3", "0", 0)).toEqual({ refundMinor: 0, taxMinor: 0 });
  });
});

describe("void", () => {
  it("voids in the window: stock back, drawer cash out, valid command", async () => {
    const fx = await setup();
    const sale = await sell(fx);
    fx.clock.t += 60_000;
    const { voidId } = await voidSale(voidDeps(fx, false), { saleId: sale.saleId, reason: "left" });
    const cmd = (await bodies(fx, "void_sale"))[0];
    expect(VoidSaleSchema.safeParse(cmd).success).toBe(true);
    expect(cmd).toMatchObject({ id: voidId, saleId: sale.saleId });
    expect(
      await fx.db.all("SELECT * FROM local_movements WHERE ref_id = ?", [voidId]),
    ).toHaveLength(2);
    const z = await zReport(fx.db, sale.shiftId);
    expect(z).toMatchObject({ salesCount: 1, voidedCount: 1, salesMinor: 0, cashSalesMinor: 0 });
    const stored = (await saleById(fx.db, sale.saleId))!;
    expect(stored.voidedAt).toBeDefined();
    expect(await returnableLines(fx.db, stored)).toEqual([]);
  });

  it("refuses double void, void after return, and late void without approval", async () => {
    const fx = await setup();
    const a = await sell(fx);
    await voidSale(voidDeps(fx), { saleId: a.saleId, reason: "x" });
    await expect(voidSale(voidDeps(fx), { saleId: a.saleId, reason: "x" })).rejects.toMatchObject({
      code: "already",
    });

    const b = await sell(fx);
    const stored = (await saleById(fx.db, b.saleId))!;
    await commitReturn(returnDeps(fx), {
      sale: stored,
      lines: [{ saleLine: 0, qty: "1", disposition: "restock" }],
      reason: "x",
    });
    await expect(voidSale(voidDeps(fx), { saleId: b.saleId, reason: "x" })).rejects.toMatchObject({
      code: "returned",
    });

    const c = await sell(fx);
    fx.clock.t += VOID_WINDOW_MS + 1000;
    await expect(
      voidSale(voidDeps(fx, false), { saleId: c.saleId, reason: "x" }),
    ).rejects.toMatchObject({
      code: "needs_override",
    });
    const approval = {
      id: uuidv7(),
      permission: "sales:void",
      approverId: uuidv7(),
      requesterId: ids.operator,
      reason: "ok",
      subjectId: "s",
      at: fx.clock.t,
    };
    await voidSale(voidDeps(fx, false), { saleId: c.saleId, reason: "late", approval });
    expect((await types(fx)).slice(-2)).toEqual(["record_override", "void_sale"]);
    expect((await bodies(fx, "void_sale")).at(-1)).toMatchObject({ overrideId: approval.id });
    await expect(voidSale(voidDeps(fx), { saleId: uuidv7(), reason: "x" })).rejects.toMatchObject({
      code: "no_sale",
    });
    await expect(voidSale(voidDeps(fx), { saleId: c.saleId, reason: " " })).rejects.toMatchObject({
      code: "reason_required",
    });
  });

  it("a void in a later shift comes out of that shift's drawer", async () => {
    const fx = await setup();
    const a = await sell(fx);
    await closeShift(shiftDeps(fx), { countedMinor: 1985, blind: false });
    fx.clock.t += 120_000;
    const open = await openShift(shiftDeps(fx), { floatMinor: 1000, currency: "USD" });
    await voidSale(voidDeps(fx), { saleId: a.saleId, reason: "x" });
    const z = await zReport(fx.db, open.id);
    expect(z).toMatchObject({
      voidedCount: 1,
      cashSalesMinor: -1985,
      expectedCashMinor: 1000 - 1985,
    });
    expect(voidNeedsOverride(0, VOID_WINDOW_MS + 1, () => false)).toBe(true);
    expect(voidNeedsOverride(0, VOID_WINDOW_MS + 1, () => true)).toBe(false);
  });
});
