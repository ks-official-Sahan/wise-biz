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

/** Index into an array built in step with another one (same length by construction). */
function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  /* v8 ignore next */
  if (v === undefined) throw new TaxPolicyError("internal: index out of step");
  return v;
}
function got<K, V>(m: ReadonlyMap<K, V>, k: K): V {
  const v = m.get(k);
  /* v8 ignore next */
  if (v === undefined) throw new TaxPolicyError("internal: missing entry");
  return v;
}

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
    (a, b) => a.order - b.order || Number(a.id > b.id) - Number(a.id < b.id),
  );
}

const applies = (rule: TaxRule, category: string) =>
  rule.categories.includes("*") || rule.categories.includes(category);

/** A non-negative rational in bigint (n / d, d > 0). */
interface Frac {
  n: bigint;
  d: bigint;
}
const BPS = 10_000n;

/**
 * Each rule's tax as a fraction of the line's net, in evaluation order: simple rate r -> r; compound c -> c x (1 + the
 * fractions so far). Gross = net x (1 + sum). All exact; denominators are powers of 10_000.
 */
function taxFractions(rules: readonly TaxRule[]): { fractions: Frac[]; gross: Frac } {
  let d = 1n;
  let sumN = 0n; // sum of fractions so far, over d
  const fractions: Frac[] = [];
  for (const r of rules) {
    const rate = BigInt(r.rateBps);
    let f: Frac;
    if (r.compound) {
      // c x (1 + sum) = c x (d + sumN) / (d x BPS)
      f = { n: rate * (d + sumN), d: d * BPS };
    } else f = { n: rate, d: BPS };
    // bring everything to a common denominator
    const nd = d * f.d;
    sumN = sumN * f.d + f.n * d;
    d = nd;
    fractions.push(f);
  }
  return { fractions, gross: { n: d + sumN, d } };
}

/** Rounds n / d (d > 0) to an integer, returning the rounded value and the exact remainder as a fraction of one unit. */
function roundFrac(n: bigint, d: bigint, mode: RoundingMode): { value: number; rest: Frac } {
  const value = divRound(n, d, mode);
  return { value: Number(value), rest: { n: n - value * d, d } };
}

const cmp = (a: Frac, b: Frac): number => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l > r ? 1 : l < r ? -1 : 0;
};

/**
 * Inclusive: every tax is an exact fraction of the gross (tax_r = gross x f_r / G), rounded once per line; per-document
 * rounds each rule's exact document total once and moves the difference, one minor unit at a time, onto the lines whose
 * exact tax was rounded furthest the other way. Net = gross - taxes, so gross never moves.
 */
function inclusiveTaxes(
  lines: readonly { amount: number; rules: readonly TaxRule[] }[],
  order: readonly TaxRule[],
  strategy: TaxStrategy,
  mode: RoundingMode,
): Map<TaxRule, number>[] {
  const per = lines.map((l) => {
    const { fractions, gross } = taxFractions(l.rules);
    const exact = new Map<TaxRule, Frac>();
    l.rules.forEach((r, k) => {
      const f = at(fractions, k);
      // amount x (f.n / f.d) / (gross.n / gross.d)
      exact.set(r, { n: BigInt(l.amount) * f.n * gross.d, d: f.d * gross.n });
    });
    return exact;
  });
  const out = lines.map(() => new Map<TaxRule, number>());
  for (const rule of order) {
    const idx = per.flatMap((m, i) => (m.has(rule) ? [i] : []));
    const rounded = idx.map((i) => {
      const e = got(at(per, i), rule);
      return { i, ...roundFrac(e.n, e.d, mode) };
    });
    if (strategy === "per-document" && rounded.length > 1) {
      // exact document total = sum of the exact line taxes (common denominator)
      // Lines with the same rule set share a denominator: sum numerators per denominator, then combine the few groups.
      const groups = new Map<bigint, bigint>();
      for (const { i } of rounded) {
        const e = got(at(per, i), rule);
        groups.set(e.d, (groups.get(e.d) ?? 0n) + e.n);
      }
      let n = 0n;
      let d = 1n;
      for (const [gd, gn] of groups) {
        n = n * gd + gn * d;
        d *= gd;
      }
      const target = Number(divRound(n, d, mode));
      let diff = target - rounded.reduce((a, x) => a + x.value, 0);
      const step = diff > 0 ? 1 : -1;
      // Largest positive remainder first when adding, most negative first when taking; ties by line order.
      const queue = [...rounded].sort((a, b) => step * cmp(b.rest, a.rest) || a.i - b.i);
      for (const x of queue) {
        if (diff === 0) break;
        x.value += step;
        diff -= step;
      }
    }
    for (const x of rounded) out[x.i]?.set(rule, x.value);
  }
  return out;
}

/** Exclusive: rule by rule in order; a compound rule's base is net + the line's earlier (rounded) taxes. */
function exclusiveTaxes(
  currency: string,
  lines: readonly { amount: number; rules: readonly TaxRule[] }[],
  order: readonly TaxRule[],
  strategy: TaxStrategy,
  mode: RoundingMode,
): Map<TaxRule, number>[] {
  const out = lines.map(() => new Map<TaxRule, number>());
  const soFar = lines.map(() => 0);
  for (const rule of order) {
    const idx = lines.flatMap((l, i) => (l.rules.includes(rule) ? [i] : []));
    if (idx.length === 0) continue;
    const bases = idx.map((i) => at(lines, i).amount + (rule.compound ? at(soFar, i) : 0));
    const taxed = taxForLines(
      bases.map((b) => money(b, currency)),
      rule.rateBps,
      { inclusive: false, strategy, mode },
    );
    idx.forEach((i, k) => {
      const t = at(taxed.lines, k).minor;
      out[i]?.set(rule, t);
      soFar[i] = at(soFar, i) + t;
    });
  }
  return out;
}

export function applyTax(
  currency: string,
  lines: readonly TaxInputLine[],
  policy: TaxPolicy,
): TaxResult {
  const order = check(policy);
  const mode = policy.mode ?? "half-even";
  const input = lines.map((l) => ({
    amount: l.amountMinor,
    rules: order.filter((r) => applies(r, l.taxCategory)),
  }));
  const perLine = policy.inclusive
    ? inclusiveTaxes(input, order, policy.strategy, mode)
    : exclusiveTaxes(currency, input, order, policy.strategy, mode);

  const totals = new Map<TaxRule, { base: number; amount: number }>();
  const taxed = input.map((l, i): TaxedLine => {
    const m = at(perLine, i);
    const taxes = l.rules.map((r) => ({ ruleId: r.id, amountMinor: got(m, r) }));
    const tax = taxes.reduce((a, t) => a + t.amountMinor, 0);
    // Inclusive: gross is fixed, so net absorbs the rounding of the taxes.
    const net = policy.inclusive ? l.amount - tax : l.amount;
    let earlier = 0;
    l.rules.forEach((r, k) => {
      const t = at(taxes, k).amountMinor;
      const acc = totals.get(r) ?? { base: 0, amount: 0 };
      acc.base += net + (r.compound ? earlier : 0);
      acc.amount += t;
      totals.set(r, acc);
      earlier += t;
    });
    return { netMinor: net, taxes, taxMinor: tax, grossMinor: net + tax };
  });
  const byRule = order.flatMap((r): RuleTotal[] => {
    const t = totals.get(r);
    return t === undefined
      ? []
      : [
          {
            ruleId: r.id,
            name: r.name,
            rateBps: r.rateBps,
            baseMinor: t.base,
            amountMinor: t.amount,
          },
        ];
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
