import { divRound, money, taxForLines } from "@wise-biz/money";

import type { RoundingMode, TaxStrategy } from "@wise-biz/money";

/**
 * Tax for a document's lines (universal, pure). Integer minor units only (ADR 0005); rounding lives in
 * @wise-biz/money. One policy per region: prices are either tax-inclusive or tax-exclusive.
 */
export interface TaxRule {
  readonly id: string;
  readonly name: string;
  /** 10_000 = 100 %. */
  readonly rateBps: number;
  /** Compound: charged on net + the taxes of earlier rules (e.g. a levy on top of VAT). */
  readonly compound: boolean;
  /** Tax categories it applies to (variant.tax_category); "*" = every category. */
  readonly categories: readonly string[];
  /** Evaluation order; compound rules see the taxes of every lower order. Ties break by id. */
  readonly order: number;
}

export interface TaxPolicy {
  /** true: line amounts are gross (tax included) and tax never changes them. */
  readonly inclusive: boolean;
  /** per-line: round each line's tax. per-document: round each rule's total once, spread over lines. */
  readonly strategy: TaxStrategy;
  readonly mode?: RoundingMode;
  readonly rules: readonly TaxRule[];
}

export interface TaxInputLine {
  /** Gross when the policy is inclusive, net when exclusive (after discounts). */
  readonly amountMinor: number;
  readonly taxCategory: string;
}

export interface LineTax {
  readonly ruleId: string;
  readonly amountMinor: number;
}

export interface TaxedLine {
  readonly netMinor: number;
  readonly taxes: readonly LineTax[];
  readonly taxMinor: number;
  readonly grossMinor: number;
}

export interface RuleTotal {
  readonly ruleId: string;
  readonly name: string;
  readonly rateBps: number;
  /** Sum of the amounts this rule was charged on. */
  readonly baseMinor: number;
  readonly amountMinor: number;
}

export interface TaxResult {
  readonly lines: readonly TaxedLine[];
  /** Rules that applied to at least one line, in evaluation order (receipts print this). */
  readonly byRule: readonly RuleTotal[];
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly grossMinor: number;
}

export class TaxPolicyError extends Error {
  override readonly name = "TaxPolicyError";
}

const MAX_RATE_BPS = 100_000;

function check(policy: TaxPolicy): TaxRule[] {
  const ids = new Set<string>();
  for (const r of policy.rules) {
    if (!Number.isSafeInteger(r.rateBps) || r.rateBps < 0 || r.rateBps > MAX_RATE_BPS) {
      throw new TaxPolicyError(
        `rule ${r.id}: rateBps must be an integer 0..${String(MAX_RATE_BPS)}`,
      );
    }
    if (ids.has(r.id)) throw new TaxPolicyError(`duplicate rule id ${r.id}`);
    ids.add(r.id);
  }
  return [...policy.rules].sort(
    // Ids are unique (checked above), so equal orders never compare equal.
    (a, b) => a.order - b.order || (a.id < b.id ? -1 : 1),
  );
}

const applies = (rule: TaxRule, category: string) =>
  rule.categories.includes("*") || rule.categories.includes(category);

/**
 * Net part of an inclusive gross: gross / ((1 + Σ simple rates) × Π (1 + compound rate)), exact in bigint, rounded once.
 * Only a starting point: the final net is gross − rounded taxes, so gross never moves.
 */
function provisionalNet(gross: number, rules: readonly TaxRule[], mode: RoundingMode): number {
  let num = BigInt(gross) * 10_000n;
  let simple = 10_000n;
  let den = 1n;
  for (const r of rules) {
    if (r.compound) {
      num *= 10_000n;
      den *= 10_000n + BigInt(r.rateBps);
    } else simple += BigInt(r.rateBps);
  }
  return Number(divRound(num, simple * den, mode));
}

export function applyTax(
  currency: string,
  lines: readonly TaxInputLine[],
  policy: TaxPolicy,
): TaxResult {
  const rules = check(policy);
  const mode = policy.mode ?? "half-even";
  const state = lines.map((l) => {
    const set = rules.filter((r) => applies(r, l.taxCategory));
    return {
      amount: l.amountMinor,
      rules: new Set(set),
      net: policy.inclusive ? provisionalNet(l.amountMinor, set, mode) : l.amountMinor,
      taxes: [] as LineTax[],
      tax: 0,
    };
  });
  const totals: (RuleTotal & { rule: TaxRule })[] = [];

  for (const rule of rules) {
    const on = state.filter((s) => s.rules.has(rule));
    if (on.length === 0) continue;
    const bases = on.map((s) => s.net + (rule.compound ? s.tax : 0));
    const out = taxForLines(
      bases.map((b) => money(b, currency)),
      rule.rateBps,
      { inclusive: false, strategy: policy.strategy, mode },
    );
    on.forEach((s, k) => {
      // taxForLines returns exactly one tax per base, in order.
      /* v8 ignore next */
      const t = out.lines[k]?.minor ?? 0;
      s.taxes.push({ ruleId: rule.id, amountMinor: t });
      s.tax += t;
    });
    totals.push({
      rule,
      ruleId: rule.id,
      name: rule.name,
      rateBps: rule.rateBps,
      baseMinor: bases.reduce((a, b) => a + b, 0),
      amountMinor: out.total.minor,
    });
  }

  // Inclusive: gross is fixed, so net absorbs the rounding of the taxes.
  const taxed = state.map((s): TaxedLine => {
    const net = policy.inclusive ? s.amount - s.tax : s.amount;
    s.net = net;
    return { netMinor: net, taxes: s.taxes, taxMinor: s.tax, grossMinor: net + s.tax };
  });
  const byRule = totals.map(({ rule, ...t }): RuleTotal => {
    // Inclusive simple rules report their base on the final net (what receipts print as "taxable").
    if (!policy.inclusive || rule.compound) return t;
    const base = state.reduce((a, s) => (s.rules.has(rule) ? a + s.net : a), 0);
    return { ...t, baseMinor: base };
  });
  const sum = (f: (l: TaxedLine) => number) => taxed.reduce((a, l) => a + f(l), 0);
  return {
    lines: taxed,
    byRule,
    netMinor: sum((l) => l.netMinor),
    taxMinor: sum((l) => l.taxMinor),
    grossMinor: sum((l) => l.grossMinor),
  };
}
