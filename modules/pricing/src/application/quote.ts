import { priceCart, PricingError } from "@wise-biz/pricing-engine";

import { PROMO_COLS, toPromotion } from "./promotions.ts";
import { getPriceList, listFees, loadRegions } from "./setup.ts";
import { invalid } from "./shared.ts";

import type { PromoRow } from "./promotions.ts";
import type { QuoteSchema } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";
import type { CartLine, PricedCart, Promotion } from "@wise-biz/pricing-engine";
import type { z } from "zod";

export type CouponStatus = "applied" | "unknown" | "inactive" | "exhausted";
export interface Quote extends PricedCart {
  readonly coupons: readonly { readonly code: string; readonly status: CouponStatus }[];
}

/**
 * Server-side price of a cart with the same engine the devices run. Read-only: no audit, no events. Every lookup is
 * one indexed query for the whole cart (prices, variant facts, coupons by `= any`), so cost does not grow per line in
 * round trips. Coupon max uses are enforced here; uses are counted when a sale completes (sales module).
 */
/**
 * Inventory owns batches; the composition root injects this read (one indexed query for the cart) so a batch with its
 * own sale price wins over the price list (data-model.md, Batches and FEFO) without a cross-module table read.
 */
export type BatchPrices = (
  tx: TxHandle,
  tenantId: string,
  batchIds: readonly string[],
) => Promise<
  ReadonlyMap<string, { readonly variantId: string; readonly salePriceMinor: number | null }>
>;

export async function quote(
  tx: TxHandle,
  tenantId: string,
  input: z.output<typeof QuoteSchema>,
  now: Date,
  batchPrices?: BatchPrices,
): Promise<Quote> {
  // FOR SHARE: a concurrent price or tax-region write (both lock this row) finishes before or after the whole quote,
  // so one quote never mixes two snapshots.
  const list = await getPriceList(tx, tenantId, input.priceListId, "share");
  const at = now.toISOString();
  if (
    list === undefined ||
    list.archived ||
    (list.validFrom !== null && at < list.validFrom) ||
    (list.validTo !== null && at >= list.validTo)
  ) {
    return invalid("priceListId", "This price list is not in force.");
  }
  const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
  const [prices, facts, regions, fees, promos, coupons] = [
    await tx.query<{ variant_id: string; price_minor: string }>(
      `select variant_id, price_minor from pricing.prices
       where tenant_id = $1 and price_list_id = $2 and variant_id = any($3::uuid[])`,
      [tenantId, list.id, variantIds],
    ),
    await tx.query<{
      variant_id: string;
      tax_category: string;
      category_ids: string[];
      archived: boolean;
    }>(
      `select variant_id, tax_category, category_ids, archived from pricing.variant_facts
       where tenant_id = $1 and variant_id = any($2::uuid[])`,
      [tenantId, variantIds],
    ),
    await loadRegions(tx, tenantId, [list.taxRegionId]),
    await listFees(tx, tenantId, true),
    await tx.query<PromoRow>(
      `select ${PROMO_COLS} from pricing.promotions
       where tenant_id = $1 and status = 'published' and (starts_at is null or starts_at <= $2)
         and (ends_at is null or ends_at > $2)
       order by priority desc, id`,
      [tenantId, now],
    ),
    await couponsFor(tx, tenantId, input.coupons ?? []),
  ];

  const fact = new Map(facts.rows.map((f) => [f.variant_id, f]));
  const batchIds = input.lines.flatMap((l) => (l.batchId === undefined ? [] : [l.batchId]));
  if (batchIds.length > 0 && batchPrices === undefined) {
    return invalid("lines", "Batch pricing is not available here.");
  }
  const batches =
    batchIds.length === 0 || batchPrices === undefined
      ? new Map<string, { variantId: string; salePriceMinor: number | null }>()
      : await batchPrices(tx, tenantId, batchIds);
  const batchPrice = (l: (typeof input.lines)[number], i: number) => {
    if (l.batchId === undefined) return {};
    const b = batches.get(l.batchId);
    if (b?.variantId !== l.variantId)
      return invalid(`lines.${String(i)}.batchId`, "Unknown batch for this variant.");
    return b.salePriceMinor === null ? {} : { batchPriceMinor: b.salePriceMinor };
  };
  const lines: CartLine[] = input.lines.map((l, i) => {
    const f = fact.get(l.variantId);
    if (f === undefined || f.archived)
      return invalid(`lines.${String(i)}.variantId`, "Unknown or archived variant.");
    return {
      id: l.id,
      variantId: l.variantId,
      categoryIds: f.category_ids,
      taxCategory: f.tax_category,
      qty: l.qty,
      ...(l.priceOverrideMinor === undefined ? {} : { priceOverrideMinor: l.priceOverrideMinor }),
      ...batchPrice(l, i),
    };
  });
  const region = regions[0];
  /* v8 ignore next -- the foreign key keeps the list's region */
  if (region === undefined) return invalid("priceListId", "The price list has no tax region.");

  // A coupon-only promotion joins the cart only through a valid code of its own.
  const codeOf = new Map(coupons.valid.map((c) => [c.promotionId, c.code]));
  const promotions: Promotion[] = promos.rows.flatMap((row) => {
    const p = toPromotion(row);
    const code = codeOf.get(p.id);
    if (p.requiresCoupon && code === undefined) return [];
    return [
      {
        id: p.id,
        name: p.name,
        priority: p.priority,
        stackable: p.stackable,
        // Stored jsonb was validated on write; JSON has no undefined keys.
        target: p.target as Promotion["target"],
        effect: p.effect,
        ...(code === undefined ? {} : { couponCode: code }),
        ...(p.customerGroups === null ? {} : { customerGroups: p.customerGroups }),
        ...(p.startsAt === null ? {} : { startsAt: p.startsAt }),
        ...(p.endsAt === null ? {} : { endsAt: p.endsAt }),
        ...(p.minQty === null ? {} : { minQty: p.minQty }),
        ...(p.minAmountMinor === null ? {} : { minAmountMinor: p.minAmountMinor }),
      },
    ];
  });

  try {
    const priced = priceCart({
      lines,
      // The snapshot id changes with every price write, so device caches keyed by it never go stale.
      priceList: {
        id: `${list.id}:${String(list.version)}`,
        currency: list.currency,
        prices: Object.fromEntries(prices.rows.map((p) => [p.variant_id, Number(p.price_minor)])),
      },
      promotions,
      coupons: coupons.valid.map((c) => c.code),
      fees: fees.map((f) => ({
        id: f.id,
        name: f.name,
        kind: f.kind,
        value: f.value,
        taxCategory: f.taxCategory,
      })),
      tax: {
        inclusive: region.inclusive,
        strategy: region.strategy,
        mode: region.roundingMode,
        rules: region.rules,
      },
      ...(input.customerGroup === undefined ? {} : { customerGroup: input.customerGroup }),
      now: at,
      rounding: {
        mode: region.roundingMode,
        ...(list.cashIncrementMinor === null
          ? {}
          : { cashIncrementMinor: list.cashIncrementMinor }),
      },
    });
    return { ...priced, coupons: coupons.statuses };
  } catch (e) {
    if (e instanceof PricingError) return invalid("lines", e.message);
    throw e;
  }
}

async function couponsFor(tx: TxHandle, tenantId: string, codes: readonly string[]) {
  const wanted = [...new Set(codes.map((c) => c.trim()).filter((c) => c !== ""))];
  if (wanted.length === 0) return { valid: [], statuses: [] };
  const r = await tx.query<{
    code: string;
    promotion_id: string;
    max_uses: number | null;
    uses: number;
    active: boolean;
  }>(
    `select code, promotion_id, max_uses, uses, active from pricing.coupons
     where tenant_id = $1 and lower(code) = any($2::text[])`,
    [tenantId, wanted.map((c) => c.toLowerCase())],
  );
  const byCode = new Map(r.rows.map((c) => [c.code.toLowerCase(), c]));
  const valid: { code: string; promotionId: string }[] = [];
  const statuses = wanted.map((code) => {
    const c = byCode.get(code.toLowerCase());
    const status: CouponStatus =
      c === undefined
        ? "unknown"
        : !c.active
          ? "inactive"
          : c.max_uses !== null && c.uses >= c.max_uses
            ? "exhausted"
            : "applied";
    if (status === "applied" && c !== undefined) valid.push({ code, promotionId: c.promotion_id });
    return { code, status };
  });
  return { valid, statuses };
}
