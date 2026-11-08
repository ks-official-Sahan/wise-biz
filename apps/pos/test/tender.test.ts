import { CompleteSaleSchema, OpenShiftSchema, RecordOverrideSchema } from "@wise-biz/contracts";
import { uuidv7 } from "@wise-biz/ids";
import { encodeEscPos } from "@wise-biz/receipt";
import { describe, expect, it } from "vitest";

import { commitSale, loadLocations, SaleCommitError } from "../src/features/tender/model/commit.ts";
import { buildReceiptDoc } from "../src/features/tender/model/receipt-doc.ts";
import { businessDateOf } from "../src/features/tender/model/sale-command.ts";
import {
  cashTender,
  minorPerMajor,
  paid,
  remaining,
  suggestedAmounts,
} from "../src/features/tender/model/tender.ts";

import { ids, linesOf, setup } from "./support/pos-fixture.ts";

import type { TenderEntry } from "../src/features/tender/model/tender.ts";

describe("tender arithmetic", () => {
  it("gives change for over-payment and a partial tender for under-payment", () => {
    expect(cashTender(1980, 2000)).toEqual({ amountMinor: 1980, changeMinor: 20 });
    expect(cashTender(1980, 1000)).toEqual({ amountMinor: 1000, changeMinor: 0 });
    expect(cashTender(1980, -5)).toEqual({ amountMinor: 0, changeMinor: 0 });
    expect(cashTender(1980, 1980.9)).toEqual({ amountMinor: 1980, changeMinor: 0 });
  });

  it("tracks what is left across split tenders", () => {
    const t: TenderEntry[] = [{ id: "1", kind: "card", amountMinor: 1000 }];
    expect(paid(t)).toBe(1000);
    expect(remaining(1980, t)).toBe(980);
    expect(remaining(1980, [...t, { id: "2", kind: "cash", amountMinor: 2000 }])).toBe(0);
  });

  it("suggests the exact amount and the next notes", () => {
    expect(suggestedAmounts(1980, "USD")).toEqual([1980, 2000, 5000, 10000]);
    expect(suggestedAmounts(2000, "USD")).toEqual([2000, 5000, 10000]);
    expect(suggestedAmounts(0, "USD")).toEqual([]);
    expect(suggestedAmounts(4350, "JPY")).toEqual([4350, 5000, 10000]);
    expect(suggestedAmounts(1234, "XXX", 2)).toHaveLength(2);
    expect(minorPerMajor("USD")).toBe(100);
    expect(minorPerMajor("JPY")).toBe(1);
    expect(minorPerMajor("KWD")).toBe(1000);
  });

  it("names the business day by local date", () => {
    expect(businessDateOf(new Date(2026, 10, 2, 23, 59).getTime())).toBe("2026-11-02");
  });
});

describe("committing a sale", () => {
  it("writes the sale, shift, stock decrements and signed commands in one transaction that the server schema accepts", async () => {
    const { db, outbox, model, store, deps } = await setup();
    await model.addVariant(ids.tea, "2");
    await model.addVariant(ids.rice, "1");
    const pricing = model.pricing()!;
    // 2 x 5.03 + 8.00 = 18.06, tax 1.81 (per line: 1.01 + 0.80), 19.87 -> cash rounding to 0.05 = 19.85.
    expect(pricing.totals.totalMinor).toBe(1985);
    const cart = linesOf(store);
    const tenders: TenderEntry[] = [
      { id: uuidv7(), kind: "cash", amountMinor: 1985, receivedMinor: 2000, changeMinor: 15 },
    ];
    const sale = await commitSale(deps, {
      pricing,
      cart,
      tenders,
      customerId: null,
      approvals: [],
    });
    expect(sale.saleNo).toBe(1);

    const pending = await outbox.allPending();
    expect(pending.map((p) => p.command.type)).toEqual(["open_shift", "complete_sale"]);
    const [shift, completed] = pending;
    expect(OpenShiftSchema.safeParse(shift?.command.body).success).toBe(true);
    const parsed = CompleteSaleSchema.safeParse(completed?.command.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data).toMatchObject({
      payableMinor: 1985,
      cashRoundingMinor: -2,
      saleNo: 1,
      priceListVersion: 3,
    });
    // Each line is stocked out of its own location.
    expect(parsed.data?.lines.map((l) => l.locationId).sort()).toEqual([ids.loc, ids.loc2].sort());

    const moves = await db.all<{ variant_id: string; qty: string; ref_id: string }>(
      "SELECT variant_id, qty, ref_id FROM local_movements ORDER BY qty",
    );
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.ref_id === sale.saleId && m.qty.startsWith("-"))).toBe(true);
  });

  it("removes the crash-recovery draft in the same transaction, so a crash after commit cannot restore the sold cart", async () => {
    const { db, model, store, deps } = await setup();
    await model.addVariant(ids.tea, "1");
    await model.flush(); // the draft is on disk, as it is after any edit
    const draft = `current:${deps.operatorId}`;
    expect(await db.all("SELECT id FROM drafts WHERE id = ?", [draft])).toHaveLength(1);
    const pricing = model.pricing()!;
    await commitSale(deps, {
      pricing,
      cart: linesOf(store),
      tenders: [
        {
          id: uuidv7(),
          kind: "cash",
          amountMinor: pricing.totals.totalMinor,
          receivedMinor: pricing.totals.totalMinor,
          changeMinor: 0,
        },
      ],
      customerId: null,
      approvals: [],
    });
    // No finish() call: that is the step a crash would skip.
    expect(await db.all("SELECT id FROM drafts WHERE id = ?", [draft])).toHaveLength(0);
  });

  it("numbers sales in order, reuses the open shift and chains approvals before the sale", async () => {
    const { outbox, model, store, deps } = await setup();
    const t = (amount: number): TenderEntry[] => [
      { id: uuidv7(), kind: "cash", amountMinor: amount },
    ];
    await model.addVariant(ids.rice, "1");
    let pricing = model.pricing()!;
    let cart = linesOf(store);
    const first = await commitSale(deps, {
      pricing,
      cart,
      tenders: t(pricing.totals.totalMinor),
      customerId: null,
      approvals: [],
    });
    await model.finish();
    await model.addVariant(ids.rice, "1");
    pricing = model.pricing()!;
    cart = linesOf(store);
    const approval = {
      id: uuidv7(),
      permission: "sales:edit_line",
      approverId: uuidv7(),
      requesterId: ids.operator,
      reason: "changed mind",
      subjectId: cart[0]!.id,
      at: deps.now(),
    };
    const second = await commitSale(deps, {
      pricing,
      cart,
      tenders: t(pricing.totals.totalMinor),
      customerId: null,
      approvals: [approval],
    });
    expect([first.saleNo, second.saleNo]).toEqual([1, 2]);
    expect(second.shiftId).toBe(first.shiftId);
    const types = (await outbox.allPending()).map((p) => p.command.type);
    expect(types).toEqual(["open_shift", "complete_sale", "record_override", "complete_sale"]);
    const override = (await outbox.allPending())[2]?.command.body;
    expect(RecordOverrideSchema.safeParse(override).success).toBe(true);
  });

  it("refuses unbalanced payments and writes nothing", async () => {
    const { db, outbox, model, store, deps } = await setup();
    await model.addVariant(ids.rice, "1");
    const pricing = model.pricing()!;
    const cart = linesOf(store);
    await expect(
      commitSale(deps, {
        pricing,
        cart,
        tenders: [{ id: "x", kind: "cash", amountMinor: 1 }],
        customerId: null,
        approvals: [],
      }),
    ).rejects.toMatchObject({ code: "unbalanced" });
    await expect(
      commitSale(deps, {
        pricing: { lines: pricing.lines, totals: pricing.totals },
        cart,
        tenders: [],
        customerId: null,
        approvals: [],
      }),
    ).rejects.toBeInstanceOf(SaleCommitError);
    expect(await outbox.allPending()).toHaveLength(0);
    expect(await db.all("SELECT * FROM local_movements")).toHaveLength(0);
  });

  it("rolls the whole sale back when a line has no stock location", async () => {
    const { db, outbox, model, store, deps } = await setup();
    await model.addVariant(ids.rice, "1");
    const pricing = model.pricing()!;
    const cart = linesOf(store);
    const broken = {
      ...deps,
      locationOf: () => {
        throw new SaleCommitError("no_location", "none");
      },
    };
    await expect(
      commitSale(broken, {
        pricing,
        cart,
        tenders: [{ id: "x", kind: "cash", amountMinor: pricing.totals.totalMinor }],
        customerId: null,
        approvals: [],
      }),
    ).rejects.toMatchObject({ code: "no_location" });
    expect(await outbox.allPending()).toHaveLength(0);
    expect(await db.all("SELECT * FROM kv WHERE key LIKE 'pos.%'")).toHaveLength(0);
  });

  it("is ready only when the branch has stock data", async () => {
    const { db } = await setup();
    await db.run("DELETE FROM entities WHERE dataset = 'stock_branch'");
    const none = await loadLocations(db);
    expect(none.ready).toBe(false);
    expect(() => none.locationOf(ids.tea)).toThrow(SaleCommitError);
  });
});

describe("receipt of a sale", () => {
  it("prints the signed numbers: lines, rounding, cash received and change, drawer", async () => {
    const { model, store, deps } = await setup();
    await model.addVariant(ids.tea, "2");
    const pricing = model.pricing()!;
    const cart = linesOf(store);
    const tenders: TenderEntry[] = [
      { id: uuidv7(), kind: "card", amountMinor: 500, card: { provider: "mock", last4: "4242" } },
      {
        id: uuidv7(),
        kind: "cash",
        amountMinor: pricing.totals.totalMinor - 500,
        receivedMinor: 1500,
        changeMinor: 1500 - (pricing.totals.totalMinor - 500),
      },
    ];
    const sale = await commitSale(deps, {
      pricing,
      cart,
      tenders,
      customerId: null,
      approvals: [],
    });
    const doc = buildReceiptDoc({
      sale,
      pricing,
      cart,
      tenders,
      store: { name: "Wise Shop", footer: ["Thanks"] },
      locale: "en-US",
      operatorName: "Amara",
      receiptBaseUrl: "https://r.example.com/r/",
    });
    expect(doc).toMatchObject({
      number: "Receipt 000001",
      totalMinor: pricing.totals.totalMinor,
      openDrawer: true,
      changeMinor: 1500 - (pricing.totals.totalMinor - 500),
    });
    expect(doc.tenders.map((t) => t.label)).toEqual(["Card ****4242", "Cash"]);
    expect(doc.qrUrl?.startsWith("https://r.example.com/r/")).toBe(true);
    expect(doc.qrUrl?.length).toBe("https://r.example.com/r/".length + 10);
    expect(doc.taxes[0]).toMatchObject({ name: "VAT 10%" });
    expect(encodeEscPos(doc, { width: 58 }).length).toBeGreaterThan(100);
    expect(() =>
      buildReceiptDoc({
        sale,
        pricing: { lines: pricing.lines, totals: pricing.totals },
        cart,
        tenders,
        store: { name: "x" },
        locale: "en-US",
      }),
    ).toThrow("unpriced");
  });
});

describe("amount entry", () => {
  it("reads typed amounts in the currency's own digits", async () => {
    const { parseMajor } = await import("../src/features/tender/model/tender.ts");
    expect(parseMajor("19.85", "USD")).toBe(1985);
    expect(parseMajor("20", "USD")).toBe(2000);
    expect(parseMajor("20.", "USD")).toBe(2000);
    expect(parseMajor("0.5", "USD")).toBe(50);
    expect(parseMajor("500", "JPY")).toBe(500);
    expect(parseMajor("1.234", "KWD")).toBe(1234);
    expect(parseMajor("19.855", "USD")).toBeUndefined();
    expect(parseMajor("5.5", "JPY")).toBeUndefined();
    expect(parseMajor("abc", "USD")).toBeUndefined();
    expect(parseMajor("", "USD")).toBeUndefined();
  });
});

describe("review fixes", () => {
  it("commits under the given sale id and starts a new shift on a new business day", async () => {
    const { outbox, model, store, deps, clock } = await setup();
    await model.addVariant(ids.rice, "1");
    const pricing = model.pricing()!;
    const cart = linesOf(store);
    const tenders: TenderEntry[] = [
      { id: uuidv7(), kind: "cash", amountMinor: pricing.totals.totalMinor },
    ];
    const fixed = uuidv7();
    const one = await commitSale(deps, {
      pricing,
      cart,
      tenders,
      customerId: null,
      approvals: [],
      saleId: fixed,
    });
    expect(one.saleId).toBe(fixed);
    clock.t += 36 * 3_600_000;
    const two = await commitSale(deps, { pricing, cart, tenders, customerId: null, approvals: [] });
    expect(two.shiftId).not.toBe(one.shiftId);
    const types = (await outbox.allPending()).map((p) => p.command.type);
    expect(types).toEqual(["open_shift", "complete_sale", "open_shift", "complete_sale"]);
  });
});
