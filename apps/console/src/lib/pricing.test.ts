import { describe, expect, it } from "vitest";

import {
  batches,
  buildPromotion,
  describePromotion,
  exampleEffect,
  formFromPromotion,
  formatPrice,
  parsePercent,
  parsePrice,
  priceChanges,
  priceText,
  publishProblems,
  summariseChanges,
} from "./pricing.ts";

import type { Promotion } from "./pricing.ts";

const promo = (over: Partial<Promotion> = {}): Promotion => ({
  id: "p1",
  name: "Weekend",
  status: "draft",
  priority: 0,
  stackable: true,
  target: { kind: "cart" },
  effect: { kind: "percent", bps: 1000 },
  requiresCoupon: false,
  customerGroups: null,
  startsAt: null,
  endsAt: null,
  minQty: null,
  minAmountMinor: null,
  version: 1,
  publishedAt: null,
  ...over,
});

describe("price text", () => {
  it("parses typed prices to minor units for 2 and 0 decimal currencies", () => {
    expect(parsePrice("12.50", "USD")).toBe(1250);
    expect(parsePrice("1,234.5", "USD")).toBe(123_450);
    expect(parsePrice("500", "JPY")).toBe(500);
  });

  it("explains what is wrong instead of guessing", () => {
    expect(parsePrice("", "USD")).toMatch(/Enter a price/);
    expect(parsePrice("1.234", "USD")).toMatch(/decimals/);
    expect(parsePrice("abc", "USD")).toEqual(expect.any(String));
    expect(parsePrice("-5", "USD")).toMatch(/negative/);
  });

  it("round-trips stored prices through the editable text", () => {
    for (const [minor, cur] of [
      [1250, "USD"],
      [5, "USD"],
      [0, "USD"],
      [500, "JPY"],
    ] as const) {
      expect(parsePrice(priceText(minor, cur), cur)).toBe(minor);
    }
    expect(priceText(5, "USD")).toBe("0.05");
  });

  it("formats for display", () => {
    expect(formatPrice(1250, "USD")).toBe("$12.50");
  });

  it("parses percentages to basis points", () => {
    expect(parsePercent("12.5")).toBe(1250);
    expect(parsePercent("10%")).toBe(1000);
    expect(parsePercent("100")).toBe(10_000);
    expect(parsePercent("100.5")).toEqual(expect.any(String));
    expect(parsePercent("-1")).toEqual(expect.any(String));
    expect(parsePercent("1.234")).toEqual(expect.any(String));
  });
});

describe("price list changes", () => {
  const rows = [
    { variantId: "a", stored: 1000, edited: undefined },
    { variantId: "b", stored: 1000, edited: "12.00" },
    { variantId: "c", stored: null, edited: "3" },
    { variantId: "d", stored: 500, edited: "" },
    { variantId: "e", stored: 700, edited: "7.00" },
    { variantId: "f", stored: null, edited: "" },
    { variantId: "g", stored: 100, edited: "x" },
  ];

  it("sends only real changes, and removes a price when the box is emptied", () => {
    const { changes, errors } = priceChanges(rows, "USD");
    expect(changes).toEqual([
      { variantId: "b", from: 1000, to: 1200 },
      { variantId: "c", from: null, to: 300 },
      { variantId: "d", from: 500, to: null },
    ]);
    expect([...errors.keys()]).toEqual(["g"]);
    expect(summariseChanges(changes)).toEqual({ added: 1, changed: 1, removed: 1 });
  });

  it("splits a big save into batches of at most 1000", () => {
    const sizes = batches(Array.from({ length: 2500 }, (_, i) => i)).map((b) => b.length);
    expect(sizes).toEqual([1000, 1000, 500]);
    expect(batches([])).toEqual([]);
  });
});

describe("promotions", () => {
  it("describes each effect in plain words", () => {
    expect(describePromotion(promo(), "USD")).toBe("10% off the whole cart");
    expect(describePromotion(promo({ effect: { kind: "amount", amountMinor: 500 } }), "USD")).toBe(
      "$5.00 off the whole cart",
    );
    expect(
      describePromotion(
        promo({
          target: { kind: "items", variantIds: ["a", "b"] },
          effect: { kind: "bxgy", buy: 2, get: 1, getBps: 10_000 },
        }),
        "USD",
      ),
    ).toBe("Buy 2, get 1 free on 2 selections");
    expect(
      describePromotion(
        promo({
          effect: {
            kind: "bundle",
            components: [
              { variantId: "a", qty: 2 },
              { variantId: "b", qty: 1 },
            ],
            priceMinor: 2500,
          },
        }),
        "USD",
      ),
    ).toBe("Bundle of 3 items for $25.00");
  });

  it("reads a partial buy-some-get-some discount as the discount, not the remainder", () => {
    expect(
      describePromotion(promo({ effect: { kind: "bxgy", buy: 1, get: 1, getBps: 2000 } }), "USD"),
    ).toBe("Buy 1, get 1 at 20% off the whole cart");
  });

  it("shows an example without ever going below zero", () => {
    expect(exampleEffect({ kind: "percent", bps: 1000 }, 1000, 2)).toEqual({
      before: 2000,
      after: 1800,
    });
    expect(exampleEffect({ kind: "amount", amountMinor: 5000 }, 1000, 2)).toEqual({
      before: 2000,
      after: 0,
    });
    expect(exampleEffect({ kind: "fixed-price", unitPriceMinor: 800 }, 1000, 3)).toEqual({
      before: 3000,
      after: 2400,
    });
    expect(exampleEffect({ kind: "bxgy", buy: 1, get: 1, getBps: 10_000 }, 1000, 4)).toEqual({
      before: 4000,
      after: 2000,
    });
    // A fixed price above the shelf price is not a discount.
    expect(exampleEffect({ kind: "fixed-price", unitPriceMinor: 2000 }, 1000, 1).after).toBe(1000);
  });

  it("blocks publishing a draft that cannot work", () => {
    expect(publishProblems(promo())).toEqual([]);
    expect(publishProblems(promo({ target: { kind: "items" } }))).toEqual([
      "Choose at least one product or category.",
    ]);
    expect(publishProblems(promo({ effect: { kind: "percent", bps: 0 } }))).toContain(
      "The percentage is zero.",
    );
    expect(
      publishProblems(promo({ startsAt: "2026-11-02T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" })),
    ).toContain("The end must be after the start.");
  });

  it("builds the API body from the form and back", () => {
    const base = formFromPromotion(promo(), "USD");
    const built = buildPromotion(
      {
        ...base,
        name: "  Lunch ",
        effectKind: "bxgy",
        targetKind: "items",
        variantIds: ["v1"],
        buy: "2",
        get: "1",
        getPercent: "50",
        groups: "vip, staff ,",
        minAmount: "20.00",
      },
      "USD",
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toMatchObject({
      name: "Lunch",
      target: { kind: "items", variantIds: ["v1"] },
      effect: { kind: "bxgy", buy: 2, get: 1, getBps: 5000 },
      customerGroups: ["vip", "staff"],
      minAmountMinor: 2000,
      minQty: null,
    });
  });

  it("keys every problem to its field", () => {
    const base = formFromPromotion(promo(), "USD");
    const built = buildPromotion(
      {
        ...base,
        name: " ",
        priority: "5000",
        percent: "abc",
        minQty: "x",
        startsAt: "2026-11-02T10:00",
        endsAt: "2026-11-01T10:00",
      },
      "USD",
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(Object.keys(built.errors).sort()).toEqual(
      ["endsAt", "minQty", "name", "percent", "priority"].sort(),
    );
  });

  it("refuses a cart promotion with a per-item effect", () => {
    const built = buildPromotion(
      { ...formFromPromotion(promo(), "USD"), effectKind: "fixed-price", fixedPrice: "5" },
      "USD",
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors.effectKind).toMatch(/cart promotion/);
  });
});
