import { describe, expect, it } from "vitest";

import {
  CashMovementSchema,
  CloseShiftSchema,
  CompleteReturnSchema,
  CompleteSaleSchema,
  OpenDrawerSchema,
  OpenShiftSchema,
  RecordOverrideSchema,
  VoidSaleSchema,
} from "../index.ts";

const id = (n: number) => `0192f8c6-1234-7abc-8def-${String(n).padStart(12, "0")}`;
const meta = { deviceSeq: 0, prevHash: "AAAA", hash: "BBBB", signature: "CCCC" };
const at = "2026-10-31T09:00:00.000Z";
const line = {
  variantId: id(1),
  name: "Tea",
  sku: "TEA",
  locationId: id(2),
  qty: "2",
  unitPriceMinor: 500,
  priceSource: "list",
  discountMinor: 0,
  taxMinor: 0,
  totalMinor: 1000,
};
const sale = {
  id: id(3),
  shiftId: id(4),
  operatorId: id(5),
  saleNo: 1,
  currency: "USD",
  businessDate: "2026-10-31",
  completedAt: at,
  priceListId: id(6),
  priceListVersion: 1,
  engineVersion: "1.0.0",
  policyVersion: 1,
  lines: [line],
  tenders: [{ id: id(7), kind: "cash", amountMinor: 1000 }],
  subtotalMinor: 1000,
  discountMinor: 0,
  feeMinor: 0,
  taxMinor: 0,
  totalMinor: 1000,
  cashRoundingMinor: 0,
  payableMinor: 1000,
  meta,
};

describe("CompleteSale", () => {
  it("accepts a valid sale and defaults promotionIds", () => {
    expect(CompleteSaleSchema.parse(sale).promotionIds).toEqual([]);
  });
  it.each([
    ["tenders not adding up", { tenders: [{ id: id(7), kind: "cash", amountMinor: 999 }] }],
    ["lines above the total", { lines: [{ ...line, totalMinor: 2000 }] }],
    [
      "a card tender without card data",
      { tenders: [{ id: id(7), kind: "card", amountMinor: 1000 }] },
    ],
    ["a zero quantity", { lines: [{ ...line, qty: "0.0000" }] }],
    ["a float amount", { payableMinor: 10.5 }],
    ["a non-v7 id", { id: id(3).replace("-7abc", "-4abc") }],
    ["oversized line detail", { lines: [{ ...line, detail: { t: "x".repeat(3000) } }] }],
    ["bad base64 in meta", { meta: { ...meta, hash: "not base64!" } }],
  ])("rejects %s", (_name, over) => {
    expect(CompleteSaleSchema.safeParse({ ...sale, ...over }).success).toBe(false);
  });
  it("accepts a card tender with masked card data only", () => {
    const card = { provider: "acme", last4: "4242", brand: "visa", authCode: "A1" };
    const r = CompleteSaleSchema.safeParse({
      ...sale,
      tenders: [{ id: id(7), kind: "card", amountMinor: 1000, card }],
    });
    expect(r.success).toBe(true);
    expect(
      CompleteSaleSchema.safeParse({
        ...sale,
        tenders: [
          { id: id(7), kind: "card", amountMinor: 1000, card: { ...card, last4: "42424242" } },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("CompleteReturn", () => {
  const ret = {
    id: id(10),
    saleId: id(3),
    shiftId: id(4),
    operatorId: id(5),
    returnNo: 1,
    currency: "USD",
    businessDate: "2026-10-31",
    occurredAt: at,
    reason: "Damaged",
    lines: [
      {
        saleLine: 0,
        variantId: id(1),
        name: "Tea",
        sku: "TEA",
        locationId: id(2),
        qty: "1",
        refundMinor: 500,
        taxMinor: 0,
        disposition: "restock",
      },
    ],
    tenders: [{ id: id(11), kind: "cash", amountMinor: 500 }],
    totalMinor: 500,
    meta,
  };
  it("accepts a return with a receipt", () => {
    expect(CompleteReturnSchema.safeParse(ret).success).toBe(true);
  });
  it("needs an override for a no-receipt return, and sale lines with a receipt", () => {
    const noReceipt = {
      ...ret,
      saleId: null,
      lines: ret.lines.map((l) => ({ ...l, saleLine: undefined })),
    };
    expect(CompleteReturnSchema.safeParse(noReceipt).success).toBe(false);
    expect(CompleteReturnSchema.safeParse({ ...noReceipt, overrideId: id(12) }).success).toBe(true);
    expect(CompleteReturnSchema.safeParse({ ...ret, lines: noReceipt.lines }).success).toBe(false);
  });
  it("checks refund tenders and lines against the total", () => {
    expect(CompleteReturnSchema.safeParse({ ...ret, totalMinor: 400 }).success).toBe(false);
    expect(
      CompleteReturnSchema.safeParse({
        ...ret,
        tenders: [{ id: id(11), kind: "cash", amountMinor: 400 }],
      }).success,
    ).toBe(false);
  });
});

describe("shift, drawer, cash, override and void commands", () => {
  it("parse valid documents and reject bad ones", () => {
    const shift = {
      id: id(20),
      operatorId: id(5),
      businessDate: "2026-10-31",
      openedAt: at,
      currency: "USD",
      openingFloatMinor: 0,
      meta,
    };
    expect(OpenShiftSchema.safeParse(shift).success).toBe(true);
    expect(OpenShiftSchema.safeParse({ ...shift, currency: "usd" }).success).toBe(false);
    const close = { id: id(20), operatorId: id(5), closedAt: at, countedCashMinor: 100, meta };
    expect(CloseShiftSchema.parse(close).blindCount).toBe(false);
    const drawer = {
      id: id(21),
      shiftId: id(20),
      operatorId: id(5),
      openedAt: at,
      reason: "Change",
      meta,
    };
    expect(OpenDrawerSchema.safeParse(drawer).success).toBe(true);
    expect(OpenDrawerSchema.safeParse({ ...drawer, reason: "  " }).success).toBe(false);
    const cash = {
      id: id(22),
      shiftId: id(20),
      operatorId: id(5),
      kind: "pay_out",
      amountMinor: 100,
      occurredAt: at,
      reason: "Milk",
      meta,
    };
    expect(CashMovementSchema.safeParse(cash).success).toBe(true);
    expect(CashMovementSchema.safeParse({ ...cash, amountMinor: 0 }).success).toBe(false);
    const override = {
      id: id(23),
      requesterId: id(5),
      approverId: id(24),
      permission: "sales:void_late",
      reason: "Customer changed mind",
      occurredAt: at,
      meta,
    };
    expect(RecordOverrideSchema.safeParse(override).success).toBe(true);
    expect(RecordOverrideSchema.safeParse({ ...override, permission: "void" }).success).toBe(false);
    const voidSale = {
      id: id(25),
      saleId: id(3),
      shiftId: id(20),
      operatorId: id(5),
      occurredAt: at,
      reason: "Wrong item",
      meta,
    };
    expect(VoidSaleSchema.safeParse(voidSale).success).toBe(true);
    expect(VoidSaleSchema.safeParse({ ...voidSale, saleId: "x" }).success).toBe(false);
  });
});
