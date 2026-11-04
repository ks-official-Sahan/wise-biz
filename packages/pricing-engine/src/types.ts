import type { RoundingMode } from "@wise-biz/money";
import type { TaxPolicy, TaxResult } from "@wise-biz/tax";

/** Bumped whenever a rule change can change a price: stored sales record which engine priced them. */
export const ENGINE_VERSION = "1.0.0";

export interface CartLine {
  readonly id: string;
  readonly variantId: string;
  readonly categoryIds: readonly string[];
  readonly taxCategory: string;
  /** Base-unit quantity as a decimal string, up to 4 places ("1", "0.25"). Must be > 0. */
  readonly qty: string;
  /** Manual price per base unit (the caller has already checked the permission). Wins over everything. */
  readonly priceOverrideMinor?: number;
  /** Price of the batch this line sells from (P1-04 FEFO), when it differs from the list. */
  readonly batchPriceMinor?: number;
}

export interface PriceListSnapshot {
  /** Changes whenever any price changes (snapshot version): the incremental pricer caches base prices by it. */
  readonly id: string;
  readonly currency: string;
  /** Unit price per base unit, by variant id. */
  readonly prices: Readonly<Record<string, number>>;
}

export type PromotionTarget =
  | { readonly kind: "cart" }
  | {
      readonly kind: "items";
      readonly variantIds?: readonly string[];
      readonly categoryIds?: readonly string[];
    };

export type PromotionEffect =
  /** Off the remaining amount (stackable percents compound). */
  | { readonly kind: "percent"; readonly bps: number }
  /** Items: off per base unit. Cart: off once. */
  | { readonly kind: "amount"; readonly amountMinor: number }
  /** Items: sell at this unit price (only when cheaper). */
  | { readonly kind: "fixed-price"; readonly unitPriceMinor: number }
  /** Items: every `buy + get` whole units, the cheapest `get` are `getBps` off (10_000 = free). */
  | { readonly kind: "bxgy"; readonly buy: number; readonly get: number; readonly getBps: number }
  /** Whole sets of `components` sell for `priceMinor` (target is ignored). */
  | {
      readonly kind: "bundle";
      readonly components: readonly { readonly variantId: string; readonly qty: number }[];
      readonly priceMinor: number;
    };

export interface Promotion {
  readonly id: string;
  readonly name: string;
  /** Higher runs first; ties by id. */
  readonly priority: number;
  /**
   * Stackable promotions apply on top of earlier ones. A non-stackable one applies only to lines no promotion touched
   * yet, and then locks them (no later promotion, cart ones included). At cart level, only one non-stackable applies.
   */
  readonly stackable: boolean;
  readonly target: PromotionTarget;
  readonly effect: PromotionEffect;
  /** Only with this coupon in the cart (case-insensitive). Max uses are checked by the server, not here. */
  readonly couponCode?: string;
  readonly customerGroups?: readonly string[];
  /** ISO instants, inclusive start, exclusive end. */
  readonly startsAt?: string;
  readonly endsAt?: string;
  /** Items: minimum qty over the matching lines. */
  readonly minQty?: string;
  /** Items: minimum amount of the matching lines; cart: minimum cart amount, both after earlier discounts. */
  readonly minAmountMinor?: number;
}

export interface Fee {
  readonly id: string;
  readonly name: string;
  /** percent: of the cart after discounts (bps). amount: fixed. */
  readonly kind: "percent" | "amount";
  readonly value: number;
  readonly taxCategory: string;
}

export interface PricingInput {
  readonly lines: readonly CartLine[];
  readonly priceList: PriceListSnapshot;
  readonly promotions?: readonly Promotion[];
  readonly coupons?: readonly string[];
  readonly fees?: readonly Fee[];
  readonly tax: TaxPolicy;
  readonly customerGroup?: string;
  /** ISO instant the cart is priced at (promotion windows). */
  readonly now: string;
  readonly rounding?: {
    readonly mode?: RoundingMode;
    /** Cash rounding increment in minor units (e.g. 5 for 0.05); the adjustment is reported, not hidden. */
    readonly cashIncrementMinor?: number;
    readonly cashMode?: RoundingMode;
  };
}

export interface AppliedDiscount {
  readonly promotionId: string;
  readonly amountMinor: number;
}

export interface PricedLine {
  readonly id: string;
  readonly variantId: string;
  readonly qty: string;
  readonly unitPriceMinor: number;
  readonly priceSource: "override" | "batch" | "list";
  /** unit price x qty, rounded once. */
  readonly baseMinor: number;
  readonly lineDiscounts: readonly AppliedDiscount[];
  /** Cart-level discounts allocated back to this line (largest remainder). */
  readonly cartDiscounts: readonly AppliedDiscount[];
  /** After every discount: gross when prices include tax, net otherwise. */
  readonly amountMinor: number;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly taxes: TaxResult["lines"][number]["taxes"];
  readonly totalMinor: number;
}

export interface PricedFee {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly netMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

export interface PricedCart {
  readonly engine: string;
  readonly currency: string;
  readonly priceListId: string;
  readonly lines: readonly PricedLine[];
  readonly fees: readonly PricedFee[];
  readonly taxes: TaxResult["byRule"];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly feeMinor: number;
  readonly taxMinor: number;
  /** Tax-exclusive policies: subtotal - discounts + fees + tax. Inclusive: subtotal - discounts + fees. */
  readonly totalMinor: number;
  readonly cashRoundingMinor: number;
  readonly payableMinor: number;
  /** Human-readable reasons, in the order the engine applied them (receipts, support, the console). */
  readonly trace: readonly string[];
}

export type PricingErrorCode = "NO_PRICE" | "BAD_QTY" | "BAD_INPUT";

export class PricingError extends Error {
  override readonly name = "PricingError";
  readonly code: PricingErrorCode;
  constructor(code: PricingErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
