import { expect, it } from "vitest";

import { createPricer, priceCart } from "../src/index.ts";

import type { CartLine, PricingInput, Promotion } from "../src/index.ts";

// Opt-in (pnpm -F @wise-biz/pricing-engine bench). Budgets from docs/prompts/P1/03-pricing-tax.md.
const FULL_BUDGET_MS = 2;
const INCREMENTAL_BUDGET_MS = 0.3;

const prices: Record<string, number> = {};
for (let v = 0; v < 400; v++) prices[`v${String(v)}`] = 99 + v * 37;
const lines: CartLine[] = Array.from({ length: 100 }, (_, i) => ({
  id: `l${String(i)}`,
  variantId: `v${String((i * 7) % 400)}`,
  categoryIds: [i % 3 === 0 ? "drinks" : "food"],
  taxCategory: i % 5 === 0 ? "food" : "standard",
  qty: i % 4 === 0 ? "0.755" : String(1 + (i % 3)),
}));
const promotions: Promotion[] = [
  {
    id: "drinks10",
    name: "Drinks 10 %",
    priority: 5,
    stackable: true,
    target: { kind: "items", categoryIds: ["drinks"] },
    effect: { kind: "percent", bps: 1000 },
  },
  {
    id: "b2g1",
    name: "B2G1",
    priority: 4,
    stackable: false,
    target: { kind: "items", categoryIds: ["food"] },
    effect: { kind: "bxgy", buy: 2, get: 1, getBps: 10_000 },
  },
  {
    id: "bundle",
    name: "Bundle",
    priority: 3,
    stackable: true,
    target: { kind: "items" },
    effect: {
      kind: "bundle",
      components: [
        { variantId: "v7", qty: 1 },
        { variantId: "v14", qty: 1 },
      ],
      priceMinor: 500,
    },
  },
  {
    id: "cart5",
    name: "Cart 5 %",
    priority: 1,
    stackable: true,
    target: { kind: "cart" },
    minAmountMinor: 10_000,
    effect: { kind: "percent", bps: 500 },
  },
];
const input: PricingInput = {
  lines,
  priceList: { id: "pl-1", currency: "LKR", prices },
  promotions,
  fees: [{ id: "svc", name: "Service", kind: "percent", value: 1000, taxCategory: "standard" }],
  tax: {
    inclusive: true,
    strategy: "per-document",
    rules: [
      {
        id: "vat",
        name: "VAT",
        rateBps: 1800,
        compound: false,
        categories: ["standard"],
        order: 1,
      },
      {
        id: "levy",
        name: "Levy",
        rateBps: 250,
        compound: true,
        categories: ["standard"],
        order: 2,
      },
    ],
  },
  now: "2026-10-29T10:00:00.000Z",
  rounding: { cashIncrementMinor: 100 },
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

it(`100-line cart: full < ${String(FULL_BUDGET_MS)} ms, one changed line < ${String(INCREMENTAL_BUDGET_MS)} ms`, () => {
  for (let i = 0; i < 200; i++) priceCart(input); // JIT warm-up
  const full: number[] = [];
  for (let i = 0; i < 300; i++) {
    const t0 = performance.now();
    priceCart(input);
    full.push(performance.now() - t0);
  }
  const pricer = createPricer();
  pricer(input);
  const inc: number[] = [];
  for (let i = 0; i < 300; i++) {
    const changed = lines.map((l, k) => (k === 42 ? { ...l, qty: String(1 + (i % 9)) } : l));
    const t0 = performance.now();
    pricer({ ...input, lines: changed });
    inc.push(performance.now() - t0);
  }
  console.info(
    `pricing 100 lines: full median ${median(full).toFixed(3)} ms; one line changed ${median(inc).toFixed(3)} ms`,
  );
  expect(median(full)).toBeLessThan(FULL_BUDGET_MS);
  expect(median(inc)).toBeLessThan(INCREMENTAL_BUDGET_MS);
});
