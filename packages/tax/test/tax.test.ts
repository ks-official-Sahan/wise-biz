import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { applyTax, TaxPolicyError } from "../src/index.ts";

import type { TaxPolicy, TaxRule } from "../src/index.ts";

const vat = (rateBps: number, over: Partial<TaxRule> = {}): TaxRule => ({
  id: "vat",
  name: "VAT",
  rateBps,
  compound: false,
  categories: ["*"],
  order: 1,
  ...over,
});
const policy = (rules: TaxRule[], over: Partial<TaxPolicy> = {}): TaxPolicy => ({
  inclusive: false,
  strategy: "per-line",
  rules,
  ...over,
});
const line = (amountMinor: number, taxCategory = "standard") => ({ amountMinor, taxCategory });

describe("hand-worked", () => {
  it("exclusive 15 %: 10.00 -> 1.50 tax", () => {
    const r = applyTax("USD", [line(1000)], policy([vat(1500)]));
    expect(r).toMatchObject({ netMinor: 1000, taxMinor: 150, grossMinor: 1150 });
    expect(r.byRule).toEqual([
      { ruleId: "vat", name: "VAT", rateBps: 1500, baseMinor: 1000, amountMinor: 150 },
    ]);
  });

  it("inclusive 18 % (LKR): 118.00 gross -> 100.00 net + 18.00 tax, gross unchanged", () => {
    const r = applyTax("LKR", [line(11_800)], policy([vat(1800)], { inclusive: true }));
    expect(r.lines[0]).toMatchObject({ netMinor: 10_000, taxMinor: 1800, grossMinor: 11_800 });
    expect(r.byRule[0]?.baseMinor).toBe(10_000);
  });

  it("compound levy on VAT: 100.00 -> VAT 10.00, levy 5 % of 110.00 = 5.50", () => {
    const rules = [vat(1000), vat(500, { id: "levy", name: "Levy", compound: true, order: 2 })];
    const ex = applyTax("USD", [line(10_000)], policy(rules));
    expect(ex.lines[0]?.taxes).toEqual([
      { ruleId: "vat", amountMinor: 1000 },
      { ruleId: "levy", amountMinor: 550 },
    ]);
    expect(ex.grossMinor).toBe(11_550);
    const inc = applyTax("USD", [line(11_550)], policy(rules, { inclusive: true }));
    expect(inc.lines[0]).toMatchObject({ netMinor: 10_000, taxMinor: 1550, grossMinor: 11_550 });
  });

  it("two simple rates on one category, a zero-rated category untouched", () => {
    const rules = [
      vat(800, { id: "vat", categories: ["standard"] }),
      vat(200, { id: "ssl", name: "SSCL", categories: ["standard"], order: 2 }),
    ];
    const r = applyTax("LKR", [line(10_000), line(5000, "food")], policy(rules));
    expect(r.lines[0]?.taxMinor).toBe(1000);
    expect(r.lines[1]).toMatchObject({ taxMinor: 0, taxes: [], grossMinor: 5000 });
    expect(r.byRule.map((t) => t.baseMinor)).toEqual([10_000, 10_000]);
  });

  it("per-line vs per-document rounding: 3 x 3.33 at 10 %", () => {
    const lines = [line(333), line(333), line(333)];
    expect(applyTax("USD", lines, policy([vat(1000)])).taxMinor).toBe(99);
    const doc = applyTax("USD", lines, policy([vat(1000)], { strategy: "per-document" }));
    expect(doc.taxMinor).toBe(100);
    expect(doc.lines.map((l) => l.taxMinor).sort()).toEqual([33, 33, 34]);
  });

  it("JPY (0 decimals) and KWD (3 decimals) inclusive", () => {
    expect(
      applyTax("JPY", [line(1100)], policy([vat(1000)], { inclusive: true })).lines[0],
    ).toMatchObject({
      netMinor: 1000,
      taxMinor: 100,
    });
    expect(
      applyTax("KWD", [line(1_050)], policy([vat(500)], { inclusive: true })).lines[0],
    ).toMatchObject({
      netMinor: 1000,
      taxMinor: 50,
    });
  });

  it("refund lines (negative) mirror sales; no rules = no tax", () => {
    expect(applyTax("USD", [line(-1000)], policy([vat(1500)])).taxMinor).toBe(-150);
    expect(applyTax("USD", [line(1000)], policy([]))).toMatchObject({ taxMinor: 0, byRule: [] });
  });

  it("equal order breaks ties by id; rounding mode is honoured", () => {
    const rules = [
      vat(1000, { id: "b", order: 1 }),
      vat(1000, { id: "a", order: 1 }),
      vat(1000, { id: "c", order: 0 }),
    ];
    expect(applyTax("USD", [line(100)], policy(rules)).byRule.map((t) => t.ruleId)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(applyTax("USD", [line(5)], policy([vat(1000)], { mode: "half-up" })).taxMinor).toBe(1);
    expect(applyTax("USD", [line(5)], policy([vat(1000)])).taxMinor).toBe(0);
  });

  it("rejects bad policies", () => {
    expect(() => applyTax("USD", [line(1)], policy([vat(-1)]))).toThrow(TaxPolicyError);
    expect(() => applyTax("USD", [line(1)], policy([vat(100_001)]))).toThrow(TaxPolicyError);
    expect(() => applyTax("USD", [line(1)], policy([vat(1), vat(2)]))).toThrow(TaxPolicyError);
  });
});

const ruleArb = fc.record({
  rateBps: fc.integer({ min: 0, max: 3000 }),
  compound: fc.boolean(),
  cat: fc.constantFrom("*", "standard", "food"),
});
const linesArb = fc.array(
  fc.record({
    amountMinor: fc.integer({ min: -1_000_000, max: 10_000_000 }),
    taxCategory: fc.constantFrom("standard", "food", "zero"),
  }),
  { minLength: 1, maxLength: 30 },
);
const policyArb = fc
  .tuple(
    fc.array(ruleArb, { maxLength: 4 }),
    fc.boolean(),
    fc.constantFrom("per-line", "per-document" as const),
  )
  .map(([rs, inclusive, strategy]): TaxPolicy => ({
    inclusive,
    strategy,
    rules: rs.map((r, i) => ({
      id: `r${String(i)}`,
      name: `R${String(i)}`,
      rateBps: r.rateBps,
      compound: r.compound,
      categories: [r.cat],
      order: i,
    })),
  }));

describe("properties", () => {
  it("inclusive never changes gross; exclusive gross = net + tax; rule totals sum to the tax", () => {
    fc.assert(
      fc.property(linesArb, policyArb, (lines, p) => {
        const r = applyTax("USD", lines, p);
        r.lines.forEach((l, i) => {
          expect(l.grossMinor).toBe(l.netMinor + l.taxMinor);
          if (p.inclusive) expect(l.grossMinor).toBe(lines[i]?.amountMinor);
          else expect(l.netMinor).toBe(lines[i]?.amountMinor);
          expect(l.taxes.reduce((a, t) => a + t.amountMinor, 0)).toBe(l.taxMinor);
        });
        expect(r.byRule.reduce((a, t) => a + t.amountMinor, 0)).toBe(r.taxMinor);
        expect(r.grossMinor).toBe(r.netMinor + r.taxMinor);
      }),
      { numRuns: 300 },
    );
  });

  it("is deterministic and input-order independent per line (per-line strategy)", () => {
    fc.assert(
      fc.property(linesArb, policyArb, (lines, p) => {
        const perLine = { ...p, strategy: "per-line" as const };
        const a = applyTax("USD", lines, perLine);
        const b = applyTax("USD", [...lines].reverse(), perLine);
        expect(JSON.stringify(a)).toBe(JSON.stringify(applyTax("USD", lines, perLine)));
        expect([...b.lines].reverse()).toEqual(a.lines);
      }),
      { numRuns: 200 },
    );
  });
});
