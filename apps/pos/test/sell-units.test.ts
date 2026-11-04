import { checkDigit } from "@wise-biz/barcode";
import { describe, expect, it } from "vitest";

import { requestApproval, unavailableOverridePort } from "../src/features/overrides/port.ts";
import { pickPriceList, toPromotion } from "../src/features/sell/model/context.ts";
import { resolveScan } from "../src/features/sell/model/scan.ts";
import { formatMinor } from "../src/features/sell/model/view.ts";
import { reportError, scrub, setReportSink } from "../src/runtime/report.ts";

const withCheck = (body: string) => `${body}${String(checkDigit(body))}`;

describe("resolveScan", () => {
  const map = new Map([
    ["4006381333931", "v-retail"],
    ["2001234", "v-weight"],
    ["2101234", "v-price"],
    ["09506000134352", "v-gs1"],
    ["SKU-1", "v-plain"],
  ]);
  const deps = { variantForBarcode: (c: string) => map.get(c) };

  it("resolves retail, plain and GS1 codes", () => {
    expect(resolveScan("4006381333931", deps)).toEqual({
      type: "variant",
      variantId: "v-retail",
      qty: "1",
    });
    expect(resolveScan(" SKU-1 ", deps)).toMatchObject({ variantId: "v-plain" });
    expect(resolveScan("(01)09506000134352(10)LOT7", deps)).toEqual({
      type: "variant",
      variantId: "v-gs1",
      qty: "1",
      batch: "LOT7",
    });
    expect(resolveScan("(01)09506000134352", deps)).toMatchObject({ variantId: "v-gs1" });
  });

  it("reads weight, price and quantity labels", () => {
    expect(resolveScan(withCheck("200123401250"), deps)).toMatchObject({ qty: "1.25" });
    expect(resolveScan(withCheck("210123400995"), deps)).toMatchObject({
      qty: "1",
      priceOverrideMinor: 995,
    });
    const qty = {
      ...deps,
      rules: [{ prefix: "20", itemDigits: 5, valueDigits: 5, kind: "qty" as const }],
    };
    expect(resolveScan(withCheck("200123400003"), qty)).toMatchObject({ qty: "3" });
    expect(resolveScan(withCheck("200123400000"), qty)).toMatchObject({ type: "unknown" });
    expect(resolveScan(withCheck("200123400000"), deps)).toMatchObject({ type: "unknown" });
  });

  it("is unknown for anything it cannot place", () => {
    expect(resolveScan("9780306406157", deps)).toEqual({ type: "unknown", code: "9780306406157" });
    expect(resolveScan("   ", deps)).toEqual({ type: "unknown", code: "" });
    expect(resolveScan(withCheck("200999901250"), deps)).toMatchObject({ type: "unknown" });
    expect(resolveScan("(17)261231", deps)).toMatchObject({ type: "unknown" });
    expect(resolveScan("(01)19999999999990", deps)).toMatchObject({ type: "unknown" });
  });
});

describe("pricing context helpers", () => {
  const list = (over: Record<string, unknown>) => ({
    priceListId: "x",
    currency: "USD",
    taxRegionId: "t",
    branchId: null,
    customerGroup: null,
    validFrom: null,
    validTo: null,
    cashIncrementMinor: null,
    version: 1,
    archived: false,
    ...over,
  });
  const now = "2026-11-02T10:00:00Z";

  it("prefers the branch list, skips archived, expired, future and group lists", () => {
    const lists = [
      list({ priceListId: "all" }),
      list({ priceListId: "branch", branchId: "b1" }),
      list({ priceListId: "other", branchId: "b2" }),
      list({ priceListId: "old", archived: true }),
      list({ priceListId: "grp", customerGroup: "vip" }),
      list({ priceListId: "past", validTo: "2026-01-01T00:00:00Z" }),
      list({ priceListId: "future", validFrom: "2027-01-01T00:00:00Z" }),
    ];
    expect(pickPriceList(lists, "b1", now)?.priceListId).toBe("branch");
    expect(pickPriceList(lists, "b9", now)?.priceListId).toBe("all");
    expect(pickPriceList([list({ archived: true })], "b1", now)).toBeUndefined();
  });

  it("maps a promotion and skips coupon-only ones", () => {
    const base = {
      promotionId: "p1",
      name: "10 off",
      priority: 5,
      stackable: true,
      target: { kind: "cart" as const },
      effect: { kind: "percent" as const, bps: 1000 },
      requiresCoupon: false,
      customerGroups: null,
      startsAt: null,
      endsAt: null,
      minQty: null,
      minAmountMinor: null,
    };
    expect(toPromotion(base)).toEqual({
      id: "p1",
      name: "10 off",
      priority: 5,
      stackable: true,
      target: { kind: "cart" },
      effect: { kind: "percent", bps: 1000 },
    });
    expect(toPromotion({ ...base, requiresCoupon: true })).toBeUndefined();
    expect(
      toPromotion({
        ...base,
        customerGroups: ["vip"],
        startsAt: "a",
        endsAt: "b",
        minQty: "2",
        minAmountMinor: 100,
      }),
    ).toMatchObject({
      customerGroups: ["vip"],
      startsAt: "a",
      endsAt: "b",
      minQty: "2",
      minAmountMinor: 100,
    });
  });

  it("formats minor units by currency decimals", () => {
    expect(formatMinor(450, "USD", "en-US")).toBe("4.50");
    expect(formatMinor(450, "JPY", "en-US")).toBe("450");
    expect(formatMinor(1234, "KWD", "en-US")).toBe("1.234");
  });
});

describe("supervisor approval", () => {
  const req = {
    permission: "sales:edit_line",
    requesterId: "u1",
    subjectId: "l1",
    reason: " changed mind ",
    approverUserId: "boss",
    pin: "1234",
  };
  const ids = () => "a1";
  const ok = { verify: () => Promise.resolve({ ok: true as const, approverId: "boss" }) };

  it("returns an approval record on success", async () => {
    expect(await requestApproval(ok, req, ids, () => 99)).toEqual({
      ok: true,
      approval: {
        id: "a1",
        permission: "sales:edit_line",
        approverId: "boss",
        requesterId: "u1",
        reason: "changed mind",
        subjectId: "l1",
        at: 99,
      },
    });
  });

  it("refuses an empty reason, self-approval, a wrong PIN and an unavailable port", async () => {
    expect(await requestApproval(ok, { ...req, reason: "  " }, ids, () => 0)).toEqual({
      ok: false,
      reason: "no_reason",
    });
    expect(await requestApproval(ok, { ...req, approverUserId: "u1" }, ids, () => 0)).toEqual({
      ok: false,
      reason: "self",
    });
    const bad = {
      verify: () => Promise.resolve({ ok: false as const, reason: "invalid" as const }),
    };
    expect(await requestApproval(bad, req, ids, () => 0)).toEqual({ ok: false, reason: "invalid" });
    expect(await requestApproval(unavailableOverridePort, req, ids, () => 0)).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});

describe("error reporting", () => {
  it("keeps only name and message and masks ids", () => {
    const e = new TypeError("bad 018f3b0e-1c2d-7abc-8def-0123456789ab body {pin:1234}");
    expect(scrub(e)).toBe("TypeError: bad <id> body {pin:1234}");
    expect(scrub("plain")).toBe("NonError: plain");
  });

  it("sends the scrubbed line to the installed sink", () => {
    const seen: string[] = [];
    setReportSink((l) => seen.push(l));
    reportError(new Error("x"));
    setReportSink(() => undefined);
    reportError(new Error("ignored"));
    expect(seen).toEqual(["Error: x"]);
  });
});
