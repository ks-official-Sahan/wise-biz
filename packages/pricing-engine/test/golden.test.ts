import { describe, expect, it } from "vitest";

import { priceCart } from "../src/index.ts";

import type { CartLine, Fee, PricingInput, Promotion } from "../src/index.ts";
import type { TaxPolicy } from "@wise-biz/tax";

// Hand-worked carts. Every expected number below was computed on paper (see the comment per case); rounding is
// half-even unless a case says otherwise.

const NOW = "2026-10-29T10:00:00.000Z";
const rule = (id: string, rateBps: number, over: Partial<TaxPolicy["rules"][number]> = {}) => ({
  id,
  name: id.toUpperCase(),
  rateBps,
  compound: false,
  categories: ["standard"],
  order: 1,
  ...over,
});
const EX_US: TaxPolicy = { inclusive: false, strategy: "per-line", rules: [rule("st", 825)] };
const INC_LK: TaxPolicy = { inclusive: true, strategy: "per-line", rules: [rule("vat", 1800)] };
const INC_JP_DOC: TaxPolicy = {
  inclusive: true,
  strategy: "per-document",
  rules: [rule("ct", 1000)],
};
const EX_JP: TaxPolicy = { inclusive: false, strategy: "per-line", rules: [rule("ct", 1000)] };
const EX_KW: TaxPolicy = { inclusive: false, strategy: "per-line", rules: [rule("vat", 500)] };

let n = 0;
const line = (variantId: string, qty: string, over: Partial<CartLine> = {}): CartLine => ({
  id: `l${String(++n)}`,
  variantId,
  categoryIds: ["c-general"],
  taxCategory: "standard",
  qty,
  ...over,
});
const promo = (over: Partial<Promotion> & Pick<Promotion, "effect">): Promotion => ({
  id: "p",
  name: "Promo",
  priority: 1,
  stackable: false,
  target: { kind: "items" },
  ...over,
});
function cart(
  currency: string,
  prices: Record<string, number>,
  lines: CartLine[],
  tax: TaxPolicy,
  over: Partial<PricingInput> = {},
): PricingInput {
  return { lines, priceList: { id: `pl-${currency}`, currency, prices }, tax, now: NOW, ...over };
}
const totals = (input: PricingInput) => {
  const r = priceCart(input);
  return {
    subtotal: r.subtotalMinor,
    discount: r.discountMinor,
    fee: r.feeMinor,
    tax: r.taxMinor,
    total: r.totalMinor,
    payable: r.payableMinor,
  };
};

describe("golden carts", () => {
  it("01 USD 1 x 10.00, 8.25 % excl: tax 82.5 -> 82 (half-even)", () => {
    expect(totals(cart("USD", { a: 1000 }, [line("a", "1")], EX_US))).toEqual({
      subtotal: 1000,
      discount: 0,
      fee: 0,
      tax: 82,
      total: 1082,
      payable: 1082,
    });
  });

  it("02 USD 3 x 2.99: base 897, tax 74.0025 -> 74", () => {
    expect(totals(cart("USD", { a: 299 }, [line("a", "3")], EX_US))).toMatchObject({
      subtotal: 897,
      tax: 74,
      total: 971,
    });
  });

  it("03 USD 0.755 kg x 12.49: base 942.995 -> 943, tax 77.7975 -> 78", () => {
    expect(totals(cart("USD", { a: 1249 }, [line("a", "0.755")], EX_US))).toMatchObject({
      subtotal: 943,
      tax: 78,
      total: 1021,
    });
  });

  it("04 USD 10 % off item: 2 x 5.00 -> 900, tax 74.25 -> 74", () => {
    const p = promo({ effect: { kind: "percent", bps: 1000 } });
    expect(
      totals(cart("USD", { a: 500 }, [line("a", "2")], EX_US, { promotions: [p] })),
    ).toMatchObject({
      discount: 100,
      tax: 74,
      total: 974,
    });
  });

  it("05 USD 0.50 off per unit on 3 x 2.00: 450, tax 37.125 -> 37", () => {
    const p = promo({ effect: { kind: "amount", amountMinor: 50 } });
    expect(
      totals(cart("USD", { a: 200 }, [line("a", "3")], EX_US, { promotions: [p] })),
    ).toMatchObject({
      discount: 150,
      tax: 37,
      total: 487,
    });
  });

  it("06 USD fixed price 1.99 on 2 x 2.49: 398, tax 32.835 -> 33", () => {
    const p = promo({ effect: { kind: "fixed-price", unitPriceMinor: 199 } });
    expect(
      totals(cart("USD", { a: 249 }, [line("a", "2")], EX_US, { promotions: [p] })),
    ).toMatchObject({
      discount: 100,
      tax: 33,
      total: 431,
    });
  });

  it("07 USD buy 2 get 1 free on 3 x 1.00: 200, tax 16.5 -> 16", () => {
    const p = promo({ effect: { kind: "bxgy", buy: 2, get: 1, getBps: 10_000 } });
    expect(
      totals(cart("USD", { a: 100 }, [line("a", "3")], EX_US, { promotions: [p] })),
    ).toMatchObject({
      discount: 100,
      tax: 16,
      total: 216,
    });
  });

  it("08 USD buy 2 get 1 across lines: the cheapest unit (B 1.00) is free; A tax 49.5 -> 50", () => {
    const p = promo({ effect: { kind: "bxgy", buy: 2, get: 1, getBps: 10_000 } });
    const r = priceCart(
      cart("USD", { a: 300, b: 100 }, [line("a", "2"), line("b", "1")], EX_US, { promotions: [p] }),
    );
    expect(r.lines.map((l) => l.amountMinor)).toEqual([600, 0]);
    expect(r).toMatchObject({ discountMinor: 100, taxMinor: 50, totalMinor: 650 });
  });

  it("09 USD bundle 5.00 + 2.00 for 6.00: 1.00 off split 71/29 by largest remainder", () => {
    const p = promo({
      effect: {
        kind: "bundle",
        components: [
          { variantId: "burger", qty: 1 },
          { variantId: "fries", qty: 1 },
        ],
        priceMinor: 600,
      },
    });
    const r = priceCart(
      cart("USD", { burger: 500, fries: 200 }, [line("burger", "1"), line("fries", "1")], EX_US, {
        promotions: [p],
      }),
    );
    expect(r.lines.map((l) => l.amountMinor)).toEqual([429, 171]);
    // 429 x 8.25 % = 35.39 -> 35; 171 x 8.25 % = 14.11 -> 14
    expect(r).toMatchObject({ discountMinor: 100, taxMinor: 49, totalMinor: 649 });
  });

  it("10 USD cart 5 % on 10.00 + 5.00: 75 off split 50/25; tax 78.375 -> 78, 39.1875 -> 39", () => {
    const p = promo({ target: { kind: "cart" }, effect: { kind: "percent", bps: 500 } });
    const r = priceCart(
      cart("USD", { a: 1000, b: 500 }, [line("a", "1"), line("b", "1")], EX_US, {
        promotions: [p],
      }),
    );
    expect(r.lines.map((l) => l.cartDiscounts)).toEqual([
      [{ promotionId: "p", amountMinor: 50 }],
      [{ promotionId: "p", amountMinor: 25 }],
    ]);
    expect(r).toMatchObject({ discountMinor: 75, taxMinor: 117, totalMinor: 1542 });
  });

  it("11 USD cart 3.00 off needs 20.00: a 15.00 cart gets nothing", () => {
    const p = promo({
      target: { kind: "cart" },
      effect: { kind: "amount", amountMinor: 300 },
      minAmountMinor: 2000,
    });
    expect(
      totals(
        cart("USD", { a: 1000, b: 500 }, [line("a", "1"), line("b", "1")], EX_US, {
          promotions: [p],
        }),
      ),
    ).toMatchObject({ discount: 0, tax: 123, total: 1623 });
  });

  it("12 USD coupon promo without its coupon: nothing", () => {
    const p = promo({ couponCode: "SAVE20", effect: { kind: "percent", bps: 2000 } });
    expect(
      totals(cart("USD", { a: 1000 }, [line("a", "1")], EX_US, { promotions: [p] })),
    ).toMatchObject({ discount: 0 });
  });

  it("13 USD coupon promo with the coupon (case-insensitive): 20 % off, tax 66", () => {
    const p = promo({ couponCode: "SAVE20", effect: { kind: "percent", bps: 2000 } });
    expect(
      totals(
        cart("USD", { a: 1000 }, [line("a", "1")], EX_US, { promotions: [p], coupons: ["save20"] }),
      ),
    ).toMatchObject({ discount: 200, tax: 66, total: 866 });
  });

  it("14 USD non-stackable 10 % (priority 5) locks the line: stackable 5 % (priority 1) skipped", () => {
    const ps = [
      promo({ id: "a", priority: 5, effect: { kind: "percent", bps: 1000 } }),
      promo({ id: "b", priority: 1, stackable: true, effect: { kind: "percent", bps: 500 } }),
    ];
    expect(
      totals(cart("USD", { a: 1000 }, [line("a", "1")], EX_US, { promotions: ps })),
    ).toMatchObject({
      discount: 100,
      tax: 74,
      total: 974,
    });
  });

  it("15 USD stackable 5 % first (priority 10): the non-stackable then finds a touched line and skips", () => {
    const ps = [
      promo({ id: "a", priority: 5, effect: { kind: "percent", bps: 1000 } }),
      promo({ id: "b", priority: 10, stackable: true, effect: { kind: "percent", bps: 500 } }),
    ];
    expect(
      totals(cart("USD", { a: 1000 }, [line("a", "1")], EX_US, { promotions: ps })),
    ).toMatchObject({
      discount: 50,
      tax: 78,
      total: 1028,
    });
  });

  it("16 USD two stackables compound: 10 % then 5 % of 900 = 45; tax 70.5375 -> 71", () => {
    const ps = [
      promo({ id: "a", priority: 5, stackable: true, effect: { kind: "percent", bps: 1000 } }),
      promo({ id: "b", priority: 1, stackable: true, effect: { kind: "percent", bps: 500 } }),
    ];
    expect(
      totals(cart("USD", { a: 1000 }, [line("a", "1")], EX_US, { promotions: ps })),
    ).toMatchObject({
      discount: 145,
      tax: 71,
      total: 926,
    });
  });

  it("17 USD 10 % service charge on 20.00, taxed: fee 200, tax 165 + 16.5 -> 16", () => {
    const fee: Fee = {
      id: "svc",
      name: "Service",
      kind: "percent",
      value: 1000,
      taxCategory: "standard",
    };
    expect(totals(cart("USD", { a: 2000 }, [line("a", "1")], EX_US, { fees: [fee] }))).toEqual({
      subtotal: 2000,
      discount: 0,
      fee: 200,
      tax: 181,
      total: 2381,
      payable: 2381,
    });
  });

  it("18 USD cash rounding to 0.05 (half-up): 10.82 -> 10.80, adjustment -2", () => {
    const r = priceCart(
      cart("USD", { a: 1000 }, [line("a", "1")], EX_US, { rounding: { cashIncrementMinor: 5 } }),
    );
    expect(r).toMatchObject({ totalMinor: 1082, cashRoundingMinor: -2, payableMinor: 1080 });
  });

  it("19 LKR 1,180.00 incl 18 %: net 1,000.00, tax 180.00, total unchanged", () => {
    const r = priceCart(cart("LKR", { a: 118_000 }, [line("a", "1")], INC_LK));
    expect(r.lines[0]).toMatchObject({ netMinor: 100_000, taxMinor: 18_000, totalMinor: 118_000 });
  });

  it("20 LKR incl with 10 % off: gross 1,062.00 -> net 900.00 + tax 162.00", () => {
    const p = promo({ effect: { kind: "percent", bps: 1000 } });
    const r = priceCart(cart("LKR", { a: 118_000 }, [line("a", "1")], INC_LK, { promotions: [p] }));
    expect(r.lines[0]).toMatchObject({ amountMinor: 106_200, netMinor: 90_000, taxMinor: 16_200 });
    expect(r.totalMinor).toBe(106_200);
  });

  it("21 LKR incl, 3 x 99.99 + 250.00: taxes 4,576 + 3,814 (minor), gross 549.97", () => {
    const r = priceCart(
      cart("LKR", { a: 9999, b: 25_000 }, [line("a", "3"), line("b", "1")], INC_LK),
    );
    // 29,997 / 1.18 = 25,421.19 -> net 25,421, tax 4,576; 25,000 / 1.18 = 21,186.44 -> 21,186, tax 3,814
    expect(r.lines.map((l) => l.taxMinor)).toEqual([4576, 3814]);
    expect(r).toMatchObject({ taxMinor: 8390, totalMinor: 54_997 });
  });

  it("22 LKR cash rounding to 1.00: 549.97 -> 550.00 (+3)", () => {
    const r = priceCart(
      cart("LKR", { a: 9999, b: 25_000 }, [line("a", "3"), line("b", "1")], INC_LK, {
        rounding: { cashIncrementMinor: 100 },
      }),
    );
    expect(r).toMatchObject({ cashRoundingMinor: 3, payableMinor: 55_000 });
  });

  it("23 JPY incl 10 % per document: 4 x 105 yen -> tax 38 on 420 (per line would say 40)", () => {
    const r = priceCart(
      cart(
        "JPY",
        { a: 105 },
        [line("a", "1"), line("a", "1"), line("a", "1"), line("a", "1")],
        INC_JP_DOC,
      ),
    );
    expect(r).toMatchObject({ taxMinor: 38, totalMinor: 420 });
    expect(r.lines.map((l) => l.totalMinor)).toEqual([105, 105, 105, 105]);
  });

  it("24 JPY excl 10 %: 3 x 333 yen = 999, tax 99.9 -> 100", () => {
    expect(totals(cart("JPY", { a: 333 }, [line("a", "3")], EX_JP))).toMatchObject({
      subtotal: 999,
      tax: 100,
      total: 1099,
    });
  });

  it("25 KWD 3 decimals: 1.250 KWD at 5 % -> 0.0625 -> 0.062", () => {
    expect(totals(cart("KWD", { a: 1250 }, [line("a", "1")], EX_KW))).toMatchObject({
      tax: 62,
      total: 1312,
    });
  });

  it("26 KWD 0.333 kg x 2.999: 998.667 -> 999, tax 49.95 -> 50", () => {
    expect(totals(cart("KWD", { a: 2999 }, [line("a", "0.333")], EX_KW))).toMatchObject({
      subtotal: 999,
      tax: 50,
      total: 1049,
    });
  });

  it("27 KWD exempt category: no tax", () => {
    expect(
      totals(cart("KWD", { a: 1000 }, [line("a", "1", { taxCategory: "exempt" })], EX_KW)),
    ).toMatchObject({
      tax: 0,
      total: 1000,
    });
  });

  it("28 USD compound levy: 100.00 + VAT 10.00 + levy 2 % of 110.00 = 2.20 -> 112.20", () => {
    const tax: TaxPolicy = {
      inclusive: false,
      strategy: "per-line",
      rules: [rule("vat", 1000), rule("levy", 200, { compound: true, order: 2 })],
    };
    const r = priceCart(cart("USD", { a: 10_000 }, [line("a", "1")], tax));
    expect(r.taxes.map((t) => [t.ruleId, t.amountMinor])).toEqual([
      ["vat", 1000],
      ["levy", 220],
    ]);
    expect(r.totalMinor).toBe(11_220);
  });

  it("29 USD mixed: standard 10.00 taxed (82), food 4.00 untaxed", () => {
    expect(
      totals(
        cart(
          "USD",
          { a: 1000, f: 400 },
          [line("a", "1"), line("f", "1", { taxCategory: "food" })],
          EX_US,
        ),
      ),
    ).toMatchObject({ tax: 82, total: 1482 });
  });

  it("30 USD price source: override 4.00 beats batch 4.50 beats list 5.00", () => {
    const r = priceCart(
      cart(
        "USD",
        { a: 500 },
        [
          line("a", "1", { priceOverrideMinor: 400, batchPriceMinor: 450 }),
          line("a", "1", { batchPriceMinor: 450 }),
          line("a", "1"),
        ],
        EX_US,
      ),
    );
    expect(r.lines.map((l) => [l.priceSource, l.baseMinor, l.taxMinor])).toEqual([
      ["override", 400, 33],
      ["batch", 450, 37],
      ["list", 500, 41],
    ]);
  });

  it("31 USD promotion windows and customer groups", () => {
    const ps = [
      promo({ id: "old", endsAt: NOW, effect: { kind: "percent", bps: 5000 } }),
      promo({
        id: "soon",
        startsAt: "2026-11-01T00:00:00.000Z",
        effect: { kind: "percent", bps: 5000 },
      }),
      promo({ id: "staff", customerGroups: ["staff"], effect: { kind: "percent", bps: 1000 } }),
    ];
    const input = cart("USD", { a: 1000 }, [line("a", "1")], EX_US, { promotions: ps });
    expect(totals(input).discount).toBe(0);
    expect(totals({ ...input, customerGroup: "staff" }).discount).toBe(100);
  });

  it("32 USD category target and min quantity", () => {
    const p = promo({
      target: { kind: "items", categoryIds: ["c-drinks"] },
      minQty: "3",
      effect: { kind: "percent", bps: 1000 },
    });
    const drinks = { categoryIds: ["c-drinks"] };
    const two = cart("USD", { d: 100, x: 100 }, [line("d", "2", drinks), line("x", "5")], EX_US, {
      promotions: [p],
    });
    expect(totals(two).discount).toBe(0);
    const three = cart("USD", { d: 100, x: 100 }, [line("d", "3", drinks), line("x", "5")], EX_US, {
      promotions: [p],
    });
    expect(totals(three).discount).toBe(30);
  });
});
