import { describe, expect, it } from "vitest";

import { SaleCompletedEnvelope, snapshotOf, toReceiptDoc } from "../src/snapshot.ts";

import { saleEvent } from "./helpers.ts";

import type { ReceiptSnapshot } from "../src/snapshot.ts";

const T = "0192f8c6-0000-7000-8000-000000000001";
const S = "0192f8c6-0000-7000-8000-000000000002";

function parsed(over?: Parameters<typeof saleEvent>[2]) {
  return SaleCompletedEnvelope.parse(saleEvent(T, S, over));
}

describe("snapshotOf (public fields only)", () => {
  it("keeps the receipt fields and drops customer, operator, terminal, branch and shift", () => {
    const env = saleEvent(T, S) as { data: Record<string, unknown> };
    const snap = snapshotOf(parsed().data);
    const json = JSON.stringify(snap);
    for (const key of ["customerId", "operatorId", "terminalId", "branchId", "shiftId", "saleId"]) {
      expect(json).not.toContain(key);
      expect(json).not.toContain(String(env.data[key]));
    }
    expect(snap).toMatchObject({ invoiceNo: "INV-000123", payableMinor: 1250, currency: "USD" });
    expect(snap.lines).toEqual([
      { sku: "SKU-1", qty: "2", unitPriceMinor: 650, discountMinor: 50, totalMinor: 1250 },
    ]);
  });

  it("rejects a mistyped field the module reads (not a permissive pass-through)", () => {
    const bad = saleEvent(T, S) as { data: { payableMinor: unknown } };
    bad.data.payableMinor = "12.50";
    expect(SaleCompletedEnvelope.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-UUIDv7 tenant and a qty that is not a decimal string", () => {
    const badTenant = { ...saleEvent(T, S), tenantId: "not-a-uuid" };
    expect(SaleCompletedEnvelope.safeParse(badTenant).success).toBe(false);
    expect(parsed().data.lines[0]?.qty).toBe("2");
    const badQty = saleEvent(T, S) as { data: { lines: { qty: string }[] } };
    badQty.data.lines[0] = { ...badQty.data.lines[0], qty: "two" };
    expect(SaleCompletedEnvelope.safeParse(badQty).success).toBe(false);
  });
});

describe("toReceiptDoc", () => {
  const base = (): ReceiptSnapshot => snapshotOf(parsed().data);

  it("maps the snapshot onto the shared renderer's document", () => {
    const doc = toReceiptDoc(base());
    expect(doc).toMatchObject({
      currency: "USD",
      locale: "en-US",
      number: "INV-000123",
      at: "2026-11-01T10:00:00.000Z",
      store: { name: "Receipt" },
      totalMinor: 1250,
      changeMinor: 0,
    });
    expect(doc.lines[0]).toMatchObject({ name: "SKU-1", qty: "2", unitMinor: 650 });
    expect(doc.taxes).toEqual([]);
  });

  it("labels tenders Cash, Card or Other from kind, and shows tax only when it is positive", () => {
    const snap = base();
    const doc = toReceiptDoc({
      ...snap,
      taxMinor: 75,
      tenders: [
        { kind: "CASH", amountMinor: 1000 },
        { kind: "card", amountMinor: 250 },
        { kind: "voucher", amountMinor: 0 },
      ],
    });
    expect(doc.tenders.map((t) => t.label)).toEqual(["Cash", "Card", "Other"]);
    expect(doc.taxes).toEqual([{ name: "Tax", amountMinor: 75 }]);
  });
});
