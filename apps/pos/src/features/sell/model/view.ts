import { createPricer } from "@wise-biz/pricing-engine";

import type { PricingContext } from "./context.ts";
import type { CartLine } from "../../../state/slices.ts";
import type { SellLine, SellTotals } from "../ui/types.ts";
import type { PriceListSnapshot, PricedCart } from "@wise-biz/pricing-engine";

export interface CartPricing {
  readonly lines: readonly SellLine[];
  readonly totals: SellTotals;
  readonly priced?: PricedCart;
  /** Set when the cart could not be priced (a price vanished in a sync): lines show, totals do not. */
  readonly error?: string;
}

/** "4.50" for 450 in USD, "450" in JPY: the currency decides the decimals. */
export function formatMinor(minor: number, currency: string, locale: string): string {
  const fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}

/**
 * Prices the cart (engine, incremental) and shapes it for the view. The pricer is per terminal: it caches line bases
 * by price-list snapshot, so changing one line re-prices that line's base only.
 */
export function createCartPricer(locale: string, now: () => number = Date.now) {
  const price = createPricer();
  return (
    lines: readonly CartLine[],
    ctx: PricingContext,
    snapshot: PriceListSnapshot,
  ): CartPricing => {
    const priced = price({
      lines: lines.map((l) => ({
        id: l.id,
        variantId: l.variantId,
        categoryIds: l.categoryIds,
        taxCategory: l.taxCategory,
        qty: l.qty,
        ...(l.priceOverrideMinor === undefined ? {} : { priceOverrideMinor: l.priceOverrideMinor }),
      })),
      priceList: snapshot,
      promotions: ctx.promotions,
      fees: ctx.fees,
      tax: ctx.tax,
      now: new Date(now()).toISOString(),
      ...(ctx.cashIncrementMinor === undefined
        ? {}
        : { rounding: { cashIncrementMinor: ctx.cashIncrementMinor } }),
    });
    const byId = new Map(lines.map((l) => [l.id, l]));
    const out: SellLine[] = priced.lines.map((p) => {
      const l = byId.get(p.id);
      const discount = [...p.lineDiscounts, ...p.cartDiscounts].reduce(
        (s, d) => s + d.amountMinor,
        0,
      );
      const unit = formatMinor(p.unitPriceMinor, priced.currency, locale);
      return {
        id: p.id,
        name: l?.name ?? p.variantId,
        detail: `${l?.sku ?? ""} · ${unit}${p.qty === "1" ? " each" : ` × ${p.qty}`}`,
        qty: Number(p.qty),
        lineTotalMinor: p.totalMinor,
        ...(discount > 0 ? { discountMinor: discount } : {}),
      };
    });
    return {
      lines: out,
      totals: {
        subtotalMinor: priced.subtotalMinor,
        discountMinor: priced.discountMinor,
        taxMinor: priced.taxMinor,
        totalMinor: priced.payableMinor,
        itemCount: lines.reduce(
          (n, l) => n + (Number(l.qty) >= 1 ? Math.round(Number(l.qty)) : 1),
          0,
        ),
        currency: priced.currency,
      },
      priced,
    };
  };
}
