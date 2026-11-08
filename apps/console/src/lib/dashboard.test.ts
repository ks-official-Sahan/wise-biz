import { describe, expect, it } from "vitest";

import { productLabel, onlineTerminals, topProducts } from "./dashboard.ts";

import type { Device } from "./devices.ts";
import type { ProductRow } from "./reports.ts";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const device = (over: Partial<Device> = {}): Device => ({
  deviceId: "d",
  tenantId: "t",
  branchId: "b",
  name: "Till 1",
  platform: "android",
  appVersion: "1.0.0",
  status: "active",
  enrolledAt: ago(86_400_000),
  lastSeenAt: ago(30_000),
  ...over,
});

const product = (over: Partial<ProductRow> = {}): ProductRow => ({
  variantId: "00000000-0000-7000-8000-000000000001",
  sku: "SKU-1",
  currency: "USD",
  qty: "1",
  revenueMinor: 0,
  taxMinor: 0,
  discountMinor: 0,
  costMinor: 0,
  netMinor: 0,
  profitMinor: 0,
  returnedQty: "0",
  refundMinor: 0,
  ...over,
});

describe("onlineTerminals", () => {
  it("counts active terminals seen within the devices page window", () => {
    const devices = [
      device({ deviceId: "a", lastSeenAt: ago(60_000) }),
      device({ deviceId: "b", lastSeenAt: ago(10 * 60_000) }),
    ];
    expect(onlineTerminals(devices, NOW)).toBe(1);
  });

  it("leaves out pending, suspended, revoked and blacklisted terminals even when recently seen", () => {
    const seen = ago(5_000);
    const devices = [
      device({ status: "pending", lastSeenAt: seen }),
      device({ status: "suspended", lastSeenAt: seen }),
      device({ status: "revoked", lastSeenAt: seen }),
      device({ status: "blacklisted", lastSeenAt: seen }),
      device({ status: "active", lastSeenAt: seen }),
    ];
    expect(onlineTerminals(devices, NOW)).toBe(1);
  });

  it("does not count a terminal that was never seen", () => {
    expect(onlineTerminals([device({ lastSeenAt: null })], NOW)).toBe(0);
  });

  it("is zero for no terminals", () => {
    expect(onlineTerminals([], NOW)).toBe(0);
  });
});

describe("topProducts", () => {
  it("takes the top n by net, highest first", () => {
    const rows = [
      product({ variantId: "v1", netMinor: 500 }),
      product({ variantId: "v2", netMinor: 2_000 }),
      product({ variantId: "v3", netMinor: 1_200 }),
    ];
    expect(topProducts(rows, "USD", 2).map((r) => r.variantId)).toEqual(["v2", "v3"]);
  });

  it("defaults to five rows", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      product({ variantId: `v${String(i)}`, netMinor: i }),
    );
    expect(topProducts(rows, "USD")).toHaveLength(5);
  });

  it("keeps only the chosen currency", () => {
    const rows = [
      product({ variantId: "usd", currency: "USD", netMinor: 100 }),
      product({ variantId: "lkr", currency: "LKR", netMinor: 999_999 }),
    ];
    expect(topProducts(rows, "USD").map((r) => r.variantId)).toEqual(["usd"]);
  });

  it("breaks ties by variant id so the order is stable", () => {
    const rows = [
      product({ variantId: "b", netMinor: 300 }),
      product({ variantId: "a", netMinor: 300 }),
    ];
    expect(topProducts(rows, "USD").map((r) => r.variantId)).toEqual(["a", "b"]);
  });

  it("does not mutate the input", () => {
    const rows = [
      product({ variantId: "x", netMinor: 1 }),
      product({ variantId: "y", netMinor: 2 }),
    ];
    topProducts(rows, "USD");
    expect(rows.map((r) => r.variantId)).toEqual(["x", "y"]);
  });

  it("returns nothing for n of zero or less", () => {
    expect(topProducts([product({ netMinor: 5 })], "USD", 0)).toEqual([]);
    expect(topProducts([product({ netMinor: 5 })], "USD", -3)).toEqual([]);
  });
});

describe("productLabel", () => {
  it("shows the SKU", () => {
    expect(
      productLabel({ sku: "COF-250", variantId: "00000000-0000-7000-8000-00000000abcd" }),
    ).toBe("COF-250");
  });

  it("falls back to the end of the variant id when the SKU is blank", () => {
    expect(productLabel({ sku: "  ", variantId: "00000000-0000-7000-8000-00000000abcd" })).toBe(
      "Product …00abcd",
    );
  });
});
