import { describe, expect, it } from "vitest";

import { ApiError } from "./api.ts";
import {
  actionErrorText,
  buildLineQty,
  buildPo,
  buildSupplier,
  buildTransfer,
  checkQty,
  inTransitText,
  lineTotalMinor,
  openQty,
  overReceiptHint,
  poActions,
  poQuery,
  qtyUnits,
  receiveHint,
  supplierQuery,
  transferActions,
  transferQuery,
  unitsQty,
  varianceText,
} from "./procurement.ts";

const ID = "0190a000-0000-7000-8000-000000000001";

describe("quantities", () => {
  it("reads quantities as ten-thousandths and back", () => {
    expect(qtyUnits("12")).toBe(120_000);
    expect(qtyUnits("2.5")).toBe(25_000);
    expect(qtyUnits("0.0003")).toBe(3);
    expect(qtyUnits("-2")).toBe(-20_000);
    expect(qtyUnits("1.23456")).toBeNull();
    expect(qtyUnits("abc")).toBeNull();
    expect(unitsQty(25_000)).toBe("2.5");
    expect(unitsQty(3)).toBe("0.0003");
    expect(unitsQty(-20_000)).toBe("-2");
    expect(unitsQty(0)).toBe("0");
  });

  it("refuses zero for a positive quantity and allows it only when asked", () => {
    expect(checkQty(" 12 ")).toEqual({ ok: true, qty: "12" });
    expect(checkQty("0").ok).toBe(false);
    expect(checkQty("0.0").ok).toBe(false);
    expect(checkQty("0", true)).toEqual({ ok: true, qty: "0" });
    expect(checkQty("-1", true).ok).toBe(false);
    expect(checkQty("1234567890").ok).toBe(false);
  });

  it("prices a line with half-even rounding through the money package", () => {
    expect(lineTotalMinor(250, "2.5", "USD")).toBe(625);
    expect(lineTotalMinor(333, "0.0003", "USD")).toBe(0);
    expect(lineTotalMinor(250, "x", "USD")).toBeNull();
  });

  it("hints when a receipt goes past the 5% tolerance, and never blocks", () => {
    expect(overReceiptHint("10", "0", "10.5")).toBeNull();
    expect(overReceiptHint("10", "0", "10.6")).toMatch(/more than 5% over/);
    expect(overReceiptHint("10", "9", "1.6")).toMatch(/more than 5% over/);
    expect(overReceiptHint("10", "9", "bad")).toBeNull();
  });

  it("reports open quantity, never below zero", () => {
    expect(openQty("10", "4")).toBe("6");
    expect(openQty("10", "12")).toBe("0");
  });
});

describe("transfer variance", () => {
  it("says short, over, or full in words (negative is short)", () => {
    expect(varianceText("-2")).toBe("Short by 2");
    expect(varianceText("1.5")).toBe("Over by 1.5");
    expect(varianceText("0")).toBe("Received in full");
    expect(varianceText("x")).toBe("Variance not known");
  });

  it("previews the variance while the receiver types", () => {
    expect(receiveHint("10", "8")).toBe("Short by 2");
    expect(receiveHint("10", "10")).toBeNull();
    expect(receiveHint("10", "")).toBeNull();
  });

  it("shows in-transit quantity and value, and waits for a currency", () => {
    expect(inTransitText({ inTransitQty: "0", inTransitValueMinor: 0, currency: null })).toBe(
      "Nothing in transit",
    );
    expect(inTransitText({ inTransitQty: "3", inTransitValueMinor: 1250, currency: null })).toBe(
      "3 in transit",
    );
    expect(inTransitText({ inTransitQty: "3", inTransitValueMinor: 1250, currency: "USD" })).toBe(
      "3 in transit, $12.50",
    );
  });
});

describe("actions by status", () => {
  const line = (receivedQty: string) => ({
    line: 1,
    variantId: ID,
    orderedQty: "5",
    receivedQty,
    shortQty: "0",
    unitCostMinor: 100,
    lineTotalMinor: 500,
  });

  it("offers the purchase order actions each status allows", () => {
    expect(poActions({ status: "draft", lines: [line("0")] })).toEqual({
      send: true,
      receive: false,
      close: false,
      cancel: true,
    });
    expect(poActions({ status: "sent", lines: [line("0")] })).toEqual({
      send: false,
      receive: true,
      close: false,
      cancel: true,
    });
    expect(poActions({ status: "sent", lines: [line("2")] }).cancel).toBe(false);
    expect(poActions({ status: "partially_received", lines: [line("2")] })).toEqual({
      send: false,
      receive: true,
      close: true,
      cancel: false,
    });
    expect(poActions({ status: "closed", lines: [line("5")] })).toEqual({
      send: false,
      receive: false,
      close: false,
      cancel: false,
    });
  });

  it("offers the transfer actions each status allows", () => {
    expect(transferActions({ status: "requested" })).toEqual({
      dispatch: true,
      cancel: true,
      receive: false,
      close: false,
    });
    expect(transferActions({ status: "dispatched" })).toEqual({
      dispatch: false,
      cancel: false,
      receive: true,
      close: false,
    });
    expect(transferActions({ status: "received" }).close).toBe(true);
    expect(transferActions({ status: "cancelled" }).cancel).toBe(false);
  });
});

describe("paging queries", () => {
  it("pages by the after cursor and passes filters only when set", () => {
    expect(supplierQuery(false, null)).toBe("limit=50&includeArchived=false");
    expect(supplierQuery(true, "abc")).toBe("limit=50&includeArchived=true&after=abc");
    expect(poQuery("", null)).toBe("limit=50");
    expect(poQuery("sent", "x")).toBe("limit=50&status=sent&after=x");
    expect(transferQuery("dispatched", null)).toBe("limit=50&status=dispatched");
  });
});

describe("forms", () => {
  const supplier = {
    name: " Tea Co ",
    contactName: "",
    email: "",
    phone: "",
    address: "",
    paymentTermsDays: "30",
    leadTimeDays: "7",
    currency: "usd",
  };

  it("builds a supplier body with trimmed text and a checked currency", () => {
    expect(buildSupplier(supplier)).toEqual({
      ok: true,
      body: {
        name: "Tea Co",
        contactName: "",
        email: "",
        phone: "",
        address: "",
        paymentTermsDays: 30,
        leadTimeDays: 7,
        currency: "USD",
      },
    });
  });

  it("explains a bad supplier without sending anything", () => {
    const r = buildSupplier({
      ...supplier,
      name: " ",
      email: "nope",
      paymentTermsDays: "400",
      currency: "XX",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([...r.errors.keys()].sort()).toEqual(["currency", "email", "name", "paymentTermsDays"]);
  });

  const po = {
    supplierId: ID,
    branchId: ID,
    locationId: ID,
    expectedOn: "",
    notes: "",
    lines: [{ key: "a", variantId: ID, qty: "12", cost: "2.50" }],
  };

  it("builds a PO with minor-unit costs in the supplier's currency", () => {
    const r = buildPo(po, "USD");
    expect(r).toEqual({
      ok: true,
      body: {
        supplierId: ID,
        branchId: ID,
        locationId: ID,
        expectedOn: null,
        notes: "",
        lines: [{ variantId: ID, orderedQty: "12", unitCostMinor: 250 }],
      },
    });
  });

  it("refuses an empty PO, a duplicate variant and a zero quantity", () => {
    const empty = buildPo({ ...po, lines: [] }, "USD");
    expect(empty.ok).toBe(false);
    const dup = buildPo(
      {
        ...po,
        lines: [
          { key: "a", variantId: ID, qty: "1", cost: "1" },
          { key: "b", variantId: ID, qty: "0", cost: "1" },
        ],
      },
      "USD",
    );
    if (dup.ok) throw new Error("expected errors");
    expect(dup.errors.get("b.variantId")).toBe("This product is already on a line.");
    expect(dup.errors.get("b.qty")).toMatch(/above zero/);
  });

  it("refuses a transfer to the same location", () => {
    const r = buildTransfer({
      fromLocationId: ID,
      toLocationId: ID,
      notes: "",
      lines: [{ key: "a", variantId: ID, qty: "2" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.get("toLocationId")).toBe("Pick a different destination.");
  });

  it("builds line quantities: blanks skipped for a PO receipt, required for a transfer", () => {
    const rows = [
      { line: 1, value: "3" },
      { line: 2, value: "" },
    ];
    expect(buildLineQty(rows, { allowZero: false, skipBlank: true })).toEqual({
      ok: true,
      body: [{ line: 1, qty: "3" }],
    });
    const strict = buildLineQty(rows, { allowZero: false, skipBlank: false });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.errors.get("line-2")).toBeDefined();
    expect(buildLineQty([{ line: 1, value: "" }], { allowZero: true, skipBlank: true }).ok).toBe(
      false,
    );
    expect(buildLineQty([{ line: 1, value: "0" }], { allowZero: true, skipBlank: false })).toEqual({
      ok: true,
      body: [{ line: 1, qty: "0" }],
    });
  });
});

describe("errors", () => {
  it("explains a 404 as not allowed or gone, and a 409 as a version clash", () => {
    expect(actionErrorText(new ApiError({ status: 404 }), "x")).toBe(
      "You may not do this, or it is already gone.",
    );
    expect(actionErrorText(new ApiError({ status: 409 }), "x")).toMatch(/changed while you/);
    expect(actionErrorText(new Error("boom"), "x")).toBe("boom");
    expect(actionErrorText("nope", "fallback")).toBe("fallback");
  });
});
