import { allocate, divRound, money, roundToIncrement } from "@wise-biz/money";
import { applyTax } from "@wise-biz/tax";

import { ENGINE_VERSION, PricingError } from "./types.ts";

import type {
  AppliedDiscount,
  CartLine,
  PricedCart,
  PricedFee,
  PricedLine,
  PricingInput,
  Promotion,
} from "./types.ts";
import type { RoundingMode } from "@wise-biz/money";

const QTY = /^\d{1,14}(\.\d{1,4})?$/;
const UNIT = 10_000;

/** Index into an array built in step with another one (same length by construction). */
function at<T>(list: readonly T[], i: number): T {
  const v = list[i];
  /* v8 ignore next */
  if (v === undefined) throw new PricingError("BAD_INPUT", "internal: index out of step");
  return v;
}

/** "1.25" -> 12_500 (ten-thousandths of a base unit). */
export function parseQty(qty: string): number {
  if (!QTY.test(qty))
    throw new PricingError(
      "BAD_QTY",
      `quantity "${qty}" must be a positive decimal, up to 4 places`,
    );
  const [whole = "0", frac = ""] = qty.split(".");
  const q4 = Number(whole) * UNIT + Number(frac.padEnd(4, "0"));
  if (q4 <= 0 || !Number.isSafeInteger(q4))
    throw new PricingError("BAD_QTY", `quantity "${qty}" must be > 0`);
  return q4;
}

const mulDiv = (a: number, b: number, den: number, mode: RoundingMode): number =>
  Number(divRound(BigInt(a) * BigInt(b), den, mode));

/** Base price of one line: the part an incremental pricer caches (depends on the line and the price list only). */
export interface LineBase {
  readonly key: string;
  readonly qty4: number;
  readonly unitPriceMinor: number;
  readonly priceSource: PricedLine["priceSource"];
  readonly baseMinor: number;
}

export function lineBase(
  line: CartLine,
  prices: Readonly<Record<string, number>>,
  mode: RoundingMode,
): LineBase {
  const qty4 = parseQty(line.qty);
  const list = prices[line.variantId];
  const [unit, source]: [number | undefined, PricedLine["priceSource"]] =
    line.priceOverrideMinor !== undefined
      ? [line.priceOverrideMinor, "override"]
      : line.batchPriceMinor !== undefined
        ? [line.batchPriceMinor, "batch"]
        : [list, "list"];
  if (unit === undefined)
    throw new PricingError("NO_PRICE", `no price for variant ${line.variantId}`);
  if (!Number.isSafeInteger(unit) || unit < 0)
    throw new PricingError("BAD_INPUT", `line ${line.id}: bad unit price`);
  return {
    key: lineKey(line),
    qty4,
    unitPriceMinor: unit,
    priceSource: source,
    baseMinor: mulDiv(unit, qty4, UNIT, mode),
  };
}

export const lineKey = (l: CartLine): string =>
  `${l.variantId}|${l.qty}|${String(l.priceOverrideMinor ?? "")}|${String(l.batchPriceMinor ?? "")}`;

interface State {
  line: CartLine;
  base: LineBase;
  remaining: number;
  lineDiscounts: AppliedDiscount[];
  cartDiscounts: AppliedDiscount[];
  touched: boolean;
  locked: boolean;
}

const byPriority = (a: Promotion, b: Promotion) =>
  b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function active(p: Promotion, input: PricingInput, coupons: ReadonlySet<string>): boolean {
  if (p.startsAt !== undefined && input.now < p.startsAt) return false;
  if (p.endsAt !== undefined && input.now >= p.endsAt) return false;
  if (p.customerGroups !== undefined && !p.customerGroups.includes(input.customerGroup ?? ""))
    return false;
  return p.couponCode === undefined || coupons.has(p.couponCode.toLowerCase());
}

function matches(p: Promotion, l: CartLine): boolean {
  if (p.effect.kind === "bundle")
    return p.effect.components.some((c) => c.variantId === l.variantId);
  if (p.target.kind !== "items") return false;
  const { variantIds, categoryIds } = p.target;
  if (variantIds === undefined && categoryIds === undefined) return true;
  return (
    variantIds?.includes(l.variantId) === true ||
    categoryIds?.some((c) => l.categoryIds.includes(c)) === true
  );
}

const units = (s: State) => (s.base.qty4 % UNIT === 0 ? s.base.qty4 / UNIT : 0);

/** Discount per candidate (same order) for an item-level promotion. */
function itemDiscounts(
  p: Promotion,
  cands: readonly State[],
  mode: RoundingMode,
  currency: string,
): number[] {
  const e = p.effect;
  switch (e.kind) {
    case "percent":
      return cands.map((s) => mulDiv(s.remaining, e.bps, UNIT, mode));
    case "amount":
      return cands.map((s) => mulDiv(e.amountMinor, s.base.qty4, UNIT, mode));
    case "fixed-price":
      return cands.map((s) => s.remaining - mulDiv(e.unitPriceMinor, s.base.qty4, UNIT, mode));
    case "bxgy": {
      const out = cands.map(() => 0);
      const whole = cands.map((s, i) => ({ s, i, u: units(s) })).filter((x) => x.u > 0);
      const total = whole.reduce((a, x) => a + x.u, 0);
      let free = Math.floor(total / (e.buy + e.get)) * e.get;
      // Cheapest units first: compare remaining/units without division; ties by line id.
      whole.sort(
        (a, b) => a.s.remaining * b.u - b.s.remaining * a.u || (a.s.line.id < b.s.line.id ? -1 : 1),
      );
      for (const x of whole) {
        if (free === 0) break;
        const k = Math.min(x.u, free);
        free -= k;
        out[x.i] = mulDiv(x.s.remaining, k * e.getBps, x.u * UNIT, mode);
      }
      return out;
    }
    case "bundle": {
      const out = cands.map(() => 0);
      const per = new Map<string, State[]>();
      for (const s of cands) {
        if (units(s) > 0) per.set(s.line.variantId, [...(per.get(s.line.variantId) ?? []), s]);
      }
      let sets = Number.MAX_SAFE_INTEGER;
      for (const c of e.components) {
        const have = (per.get(c.variantId) ?? []).reduce((a, s) => a + units(s), 0);
        sets = Math.min(sets, Math.floor(have / c.qty));
      }
      if (sets === 0) return out;
      // What the bundled units cost now, per line (lines of one variant share by their units).
      const used = cands.map((s) => {
        const c = e.components.find((x) => x.variantId === s.line.variantId);
        const all = per.get(s.line.variantId);
        if (c === undefined || all === undefined || units(s) === 0) return 0;
        const totalUnits = all.reduce((a, x) => a + units(x), 0);
        // This line holds units(s)/totalUnits of the variant, so it pays that share of the bundled units.
        return mulDiv(s.remaining, sets * c.qty, totalUnits, mode);
      });
      const regular = used.reduce((a, b) => a + b, 0);
      const discount = regular - sets * e.priceMinor;
      if (discount <= 0) return out;
      return allocate(money(discount, currency), used).map((m) => m.minor);
    }
  }
}

/** Prices a cart. Pure and deterministic: same input, byte-identical output on every device and the server. */
export function priceCart(input: PricingInput, cache?: Map<string, LineBase>): PricedCart {
  const mode = input.rounding?.mode ?? "half-even";
  const currency = input.priceList.currency;
  const trace: string[] = [];
  const coupons = new Set((input.coupons ?? []).map((c) => c.toLowerCase()));
  const ids = new Set<string>();

  const state: State[] = input.lines.map((line) => {
    if (ids.has(line.id)) throw new PricingError("BAD_INPUT", `duplicate line id ${line.id}`);
    ids.add(line.id);
    const key = lineKey(line);
    let base = cache?.get(key);
    if (base === undefined) {
      base = lineBase(line, input.priceList.prices, mode);
      cache?.set(key, base);
    }
    return {
      line,
      base,
      remaining: base.baseMinor,
      lineDiscounts: [],
      cartDiscounts: [],
      touched: false,
      locked: false,
    };
  });

  const promos = (input.promotions ?? []).filter((p) => active(p, input, coupons)).sort(byPriority);

  // 1. Item promotions (and bundles), by priority.
  for (const p of promos) {
    if (p.target.kind === "cart" && p.effect.kind !== "bundle") continue;
    const cands = state.filter(
      (s) => matches(p, s.line) && !s.locked && (p.stackable || !s.touched),
    );
    if (cands.length === 0) continue;
    if (p.minQty !== undefined && cands.reduce((a, s) => a + s.base.qty4, 0) < parseQty(p.minQty))
      continue;
    if (
      p.minAmountMinor !== undefined &&
      cands.reduce((a, s) => a + s.remaining, 0) < p.minAmountMinor
    )
      continue;
    itemDiscounts(p, cands, mode, currency).forEach((raw, k) => {
      const s = at(cands, k);
      const amt = Math.max(0, Math.min(raw, s.remaining));
      if (amt === 0) return;
      s.remaining -= amt;
      s.lineDiscounts.push({ promotionId: p.id, amountMinor: amt });
      s.touched = true;
      if (!p.stackable) s.locked = true;
      trace.push(`line ${s.line.id}: ${p.name} (${p.id}) -${String(amt)}`);
    });
  }

  // 2. Cart promotions, allocated back to the lines they cover.
  let cartApplied = false;
  for (const p of promos) {
    if (p.target.kind !== "cart" || (p.effect.kind !== "percent" && p.effect.kind !== "amount"))
      continue;
    if (!p.stackable && cartApplied) continue;
    const open = state.filter((s) => !s.locked && s.remaining > 0);
    const pool = open.reduce((a, s) => a + s.remaining, 0);
    if (pool === 0 || (p.minAmountMinor !== undefined && pool < p.minAmountMinor)) continue;
    const want =
      p.effect.kind === "percent" ? mulDiv(pool, p.effect.bps, UNIT, mode) : p.effect.amountMinor;
    const amt = Math.max(0, Math.min(want, pool));
    if (amt === 0) continue;
    const parts = allocate(
      money(amt, currency),
      open.map((s) => s.remaining),
    );
    open.forEach((s, k) => {
      const part = at(parts, k).minor;
      if (part === 0) return;
      s.remaining -= part;
      s.cartDiscounts.push({ promotionId: p.id, amountMinor: part });
    });
    cartApplied = true;
    trace.push(`cart: ${p.name} (${p.id}) -${String(amt)}`);
    if (!p.stackable) break;
  }

  // 3. Fees on the cart after discounts.
  const afterDiscounts = state.reduce((a, s) => a + s.remaining, 0);
  const fees = (input.fees ?? []).map((f) => {
    const amt = f.kind === "percent" ? mulDiv(afterDiscounts, f.value, UNIT, mode) : f.value;
    trace.push(`fee: ${f.name} (${f.id}) +${String(amt)}`);
    return { f, amt };
  });

  // 4. Tax on lines and fees together (per-document rounding spans the whole document).
  const taxed = applyTax(
    currency,
    [
      ...state.map((s) => ({ amountMinor: s.remaining, taxCategory: s.line.taxCategory })),
      ...fees.map((x) => ({ amountMinor: x.amt, taxCategory: x.f.taxCategory })),
    ],
    input.tax,
  );
  const lines: PricedLine[] = state.map((s, i) => {
    const t = at(taxed.lines, i);
    return {
      id: s.line.id,
      variantId: s.line.variantId,
      qty: s.line.qty,
      unitPriceMinor: s.base.unitPriceMinor,
      priceSource: s.base.priceSource,
      baseMinor: s.base.baseMinor,
      lineDiscounts: s.lineDiscounts,
      cartDiscounts: s.cartDiscounts,
      amountMinor: s.remaining,
      netMinor: t.netMinor,
      taxMinor: t.taxMinor,
      taxes: t.taxes,
      totalMinor: t.grossMinor,
    };
  });
  const pricedFees: PricedFee[] = fees.map((x, k) => {
    const t = at(taxed.lines, state.length + k);
    return {
      id: x.f.id,
      name: x.f.name,
      amountMinor: x.amt,
      netMinor: t.netMinor,
      taxMinor: t.taxMinor,
      totalMinor: t.grossMinor,
    };
  });

  const subtotal = state.reduce((a, s) => a + s.base.baseMinor, 0);
  const feeTotal = fees.reduce((a, x) => a + x.amt, 0);
  const total = taxed.grossMinor;
  const inc = input.rounding?.cashIncrementMinor;
  const payable =
    inc === undefined
      ? total
      : roundToIncrement(money(total, currency), inc, input.rounding?.cashMode ?? "half-up").minor;
  if (payable !== total)
    trace.push(`cash rounding ${payable > total ? "+" : ""}${String(payable - total)}`);
  return {
    engine: ENGINE_VERSION,
    currency,
    priceListId: input.priceList.id,
    lines,
    fees: pricedFees,
    taxes: taxed.byRule,
    subtotalMinor: subtotal,
    discountMinor: subtotal - afterDiscounts,
    feeMinor: feeTotal,
    taxMinor: taxed.taxMinor,
    totalMinor: total,
    cashRoundingMinor: payable - total,
    payableMinor: payable,
    trace,
  };
}

/**
 * Incremental pricer for the sell screen: base prices are cached per line (variant, qty, overrides) and per price
 * list, so a keystroke on one line re-prices that line's base only; promotions, fees and tax rerun (they span lines).
 */
export function createPricer(): (input: PricingInput) => PricedCart {
  let listId = "";
  let cache = new Map<string, LineBase>();
  return (input) => {
    if (input.priceList.id !== listId || cache.size > 5000) {
      listId = input.priceList.id;
      cache = new Map();
    }
    return priceCart(input, cache);
  };
}
