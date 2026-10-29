import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createPricer, ENGINE_VERSION, parseQty, priceCart, PricingError } from "../src/index.ts";

import type { CartLine, PricingInput, Promotion } from "../src/index.ts";
import type { TaxPolicy } from "@wise-biz/tax";

const NOW = "2026-10-29T10:00:00.000Z";
const VARIANTS = ["a", "b", "c", "d", "e"];
const CATS = ["c1", "c2"];

const taxArb: fc.Arbitrary<TaxPolicy> = fc
  .tuple(
    fc.boolean(),
    fc.constantFrom("per-line" as const, "per-document" as const),
    fc.integer({ min: 0, max: 2500 }),
  )
  .map(([inclusive, strategy, rate]) => ({
    inclusive,
    strategy,
    rules: [
      { id: "t", name: "T", rateBps: rate, compound: false, categories: ["standard"], order: 1 },
    ],
  }));

const qtyArb = fc.oneof(
  fc.integer({ min: 1, max: 20 }).map(String),
  fc.integer({ min: 1, max: 99_999 }).map((q) => (q / 10_000).toFixed(4)),
);

const lineArb = (i: number): fc.Arbitrary<CartLine> =>
  fc.record({
    id: fc.constant(`l${String(i)}`),
    variantId: fc.constantFrom(...VARIANTS),
    categoryIds: fc.subarray(CATS),
    taxCategory: fc.constantFrom("standard", "exempt"),
    qty: qtyArb,
  });

const promoArb: fc.Arbitrary<Promotion> = fc
  .record({
    id: fc.stringMatching(/^[a-z0-9]{1,4}$/),
    priority: fc.integer({ min: 0, max: 5 }),
    stackable: fc.boolean(),
    cart: fc.boolean(),
    kind: fc.constantFrom("percent", "amount", "fixed-price", "bxgy", "bundle"),
    value: fc.integer({ min: 1, max: 5000 }),
    variant: fc.constantFrom(...VARIANTS),
  })
  .map((p): Promotion => {
    const effect: Promotion["effect"] =
      p.kind === "percent"
        ? { kind: "percent", bps: p.value }
        : p.kind === "amount"
          ? { kind: "amount", amountMinor: p.value }
          : p.kind === "fixed-price"
            ? { kind: "fixed-price", unitPriceMinor: p.value }
            : p.kind === "bxgy"
              ? { kind: "bxgy", buy: 2, get: 1, getBps: 10_000 }
              : {
                  kind: "bundle",
                  components: [
                    { variantId: "a", qty: 1 },
                    { variantId: "b", qty: 1 },
                  ],
                  priceMinor: p.value,
                };
    return {
      id: p.id,
      name: p.id,
      priority: p.priority,
      stackable: p.stackable,
      target: p.cart ? { kind: "cart" } : { kind: "items", variantIds: [p.variant] },
      effect,
    };
  });

const inputArb: fc.Arbitrary<PricingInput> = fc
  .tuple(
    fc
      .integer({ min: 1, max: 25 })
      .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => lineArb(i)))),
    fc.uniqueArray(promoArb, { maxLength: 5, selector: (p) => p.id }),
    taxArb,
    fc.dictionary(fc.constantFrom(...VARIANTS), fc.integer({ min: 0, max: 500_000 })),
    fc.boolean(),
  )
  .map(([lines, promotions, tax, prices, fee]) => ({
    lines,
    promotions,
    tax,
    now: NOW,
    priceList: {
      id: "pl",
      currency: "USD",
      prices: { a: 100, b: 250, c: 999, d: 1, e: 12_345, ...prices },
    },
    fees: fee
      ? [{ id: "f", name: "Fee", kind: "percent", value: 1000, taxCategory: "standard" }]
      : [],
  }));

describe("properties", () => {
  it("totals reconcile; discounts are what the lines lost; nothing goes negative", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const r = priceCart(input);
        const exclusiveTax = input.tax.inclusive ? 0 : r.taxMinor;
        expect(r.totalMinor).toBe(r.subtotalMinor - r.discountMinor + r.feeMinor + exclusiveTax);
        let lost = 0;
        for (const l of r.lines) {
          const d = [...l.lineDiscounts, ...l.cartDiscounts].reduce((a, x) => a + x.amountMinor, 0);
          expect(l.amountMinor).toBe(l.baseMinor - d);
          expect(l.amountMinor).toBeGreaterThanOrEqual(0);
          expect(l.totalMinor).toBe(l.netMinor + l.taxMinor);
          if (input.tax.inclusive) expect(l.totalMinor).toBe(l.amountMinor);
          lost += d;
        }
        expect(lost).toBe(r.discountMinor);
        const sum =
          r.lines.reduce((a, l) => a + l.totalMinor, 0) +
          r.fees.reduce((a, f) => a + f.totalMinor, 0);
        expect(sum).toBe(r.totalMinor);
      }),
      { numRuns: 400 },
    );
  });

  it("cart discounts allocate exactly: each cart promotion's parts sum to its trace amount", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const r = priceCart(input);
        for (const t of r.trace.filter((x) => x.startsWith("cart: "))) {
          const id = /\((.*)\) -(\d+)$/.exec(t);
          const parts = r.lines
            .flatMap((l) => l.cartDiscounts)
            .filter((d) => d.promotionId === id?.[1])
            .reduce((a, d) => a + d.amountMinor, 0);
          expect(parts).toBe(Number(id?.[2]));
        }
      }),
      { numRuns: 300 },
    );
  });

  it("promotion order in the input never matters (priority, then id, decides)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const a = JSON.stringify(priceCart(input));
        const b = JSON.stringify(
          priceCart({ ...input, promotions: [...(input.promotions ?? [])].reverse() }),
        );
        expect(b).toBe(a);
      }),
      { numRuns: 300 },
    );
  });

  it("deterministic: byte-identical output for equal input (fresh objects, incremental pricer)", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        // One pricer per price-list snapshot id (its contract): the arbitrary reuses "pl" with new prices.
        const pricer = createPricer();
        const a = JSON.stringify(priceCart(input));
        expect(JSON.stringify(priceCart(structuredClone(input)))).toBe(a);
        expect(JSON.stringify(pricer(input))).toBe(a);
        expect(JSON.stringify(pricer(input))).toBe(a);
      }),
      { numRuns: 200 },
    );
  });
});

describe("edges", () => {
  const base: PricingInput = {
    lines: [{ id: "x", variantId: "a", categoryIds: [], taxCategory: "standard", qty: "1" }],
    priceList: { id: "pl", currency: "USD", prices: { a: 100 } },
    tax: { inclusive: false, strategy: "per-line", rules: [] },
    now: NOW,
  };

  it("parses quantities and rejects bad ones", () => {
    expect(parseQty("1")).toBe(10_000);
    expect(parseQty("0.0001")).toBe(1);
    expect(parseQty("12.5")).toBe(125_000);
    for (const bad of ["0", "0.0000", "-1", "1.23456", "abc", ""]) {
      expect(() => parseQty(bad)).toThrow(PricingError);
    }
  });

  it("missing price, bad override and duplicate lines are errors", () => {
    expect(() => priceCart({ ...base, priceList: { ...base.priceList, prices: {} } })).toThrow(
      /no price/,
    );
    const bad = {
      ...base,
      lines: [{ ...base.lines[0], id: "x", variantId: "a", priceOverrideMinor: -1 } as CartLine],
    };
    expect(() => priceCart(bad)).toThrow(/bad unit price/);
    expect(() => priceCart({ ...base, lines: [...base.lines, ...base.lines] })).toThrow(
      /duplicate line/,
    );
    try {
      priceCart({ ...base, priceList: { ...base.priceList, prices: {} } });
    } catch (e) {
      expect((e as PricingError).code).toBe("NO_PRICE");
    }
  });

  it("stamps the engine version and price list; an empty cart is zero", () => {
    const r = priceCart({ ...base, lines: [] });
    expect(r).toMatchObject({
      engine: ENGINE_VERSION,
      priceListId: "pl",
      totalMinor: 0,
      payableMinor: 0,
    });
  });

  it("a non-stackable cart promotion blocks later cart promotions; an amount fee is added as is", () => {
    const ps: Promotion[] = [
      {
        id: "x",
        name: "X",
        priority: 9,
        stackable: false,
        target: { kind: "cart" },
        effect: { kind: "amount", amountMinor: 10 },
      },
      {
        id: "y",
        name: "Y",
        priority: 1,
        stackable: true,
        target: { kind: "cart" },
        effect: { kind: "percent", bps: 5000 },
      },
      {
        id: "z",
        name: "Z",
        priority: 0,
        stackable: true,
        target: { kind: "cart" },
        effect: { kind: "bxgy", buy: 1, get: 1, getBps: 1 },
      },
    ];
    const r = priceCart({
      ...base,
      promotions: ps,
      fees: [{ id: "bag", name: "Bag", kind: "amount", value: 25, taxCategory: "standard" }],
    });
    expect(r).toMatchObject({ discountMinor: 10, feeMinor: 25, totalMinor: 115 });
    // A cart amount larger than the cart is capped; a zero percent applies nothing.
    const cap = priceCart({
      ...base,
      promotions: [{ ...ps[0], effect: { kind: "amount", amountMinor: 999 } } as Promotion],
    });
    expect(cap.totalMinor).toBe(0);
    const none = priceCart({
      ...base,
      promotions: [{ ...ps[1], effect: { kind: "percent", bps: 0 } } as Promotion],
    });
    expect(none.discountMinor).toBe(0);
  });

  it("items promotions with no matching lines, min amount and an unprofitable bundle do nothing", () => {
    const ps: Promotion[] = [
      {
        id: "1",
        name: "1",
        priority: 1,
        stackable: true,
        target: { kind: "items", variantIds: ["zzz"] },
        effect: { kind: "percent", bps: 1000 },
      },
      {
        id: "2",
        name: "2",
        priority: 1,
        stackable: true,
        target: { kind: "items" },
        minAmountMinor: 1000,
        effect: { kind: "percent", bps: 1000 },
      },
      {
        id: "3",
        name: "3",
        priority: 1,
        stackable: true,
        target: { kind: "items" },
        effect: { kind: "bundle", components: [{ variantId: "a", qty: 1 }], priceMinor: 500 },
      },
      {
        id: "4",
        name: "4",
        priority: 1,
        stackable: true,
        target: { kind: "items" },
        effect: { kind: "bundle", components: [{ variantId: "a", qty: 2 }], priceMinor: 1 },
      },
      {
        id: "5",
        name: "5",
        priority: 1,
        stackable: true,
        target: { kind: "items" },
        effect: { kind: "fixed-price", unitPriceMinor: 500 },
      },
    ];
    expect(priceCart({ ...base, promotions: ps }).discountMinor).toBe(0);
  });

  it("the incremental pricer reuses line bases and resets on a new price list", () => {
    const pricer = createPricer();
    const a = pricer(base);
    const b = pricer({ ...base, priceList: { id: "pl2", currency: "USD", prices: { a: 200 } } });
    expect([a.totalMinor, b.totalMinor]).toEqual([100, 200]);
  });
});
