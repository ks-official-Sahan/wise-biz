import type { RoundingMode } from "@wise-biz/money";
import type {
  Fee,
  PriceListSnapshot,
  Promotion,
  PromotionEffect,
  PromotionTarget,
} from "@wise-biz/pricing-engine";
import type { Queryable } from "@wise-biz/sync";
import type { TaxPolicy } from "@wise-biz/tax";

export interface CatalogVariant {
  readonly variantId: string;
  readonly productName: string;
  readonly name: string;
  readonly sku: string;
  readonly taxCategory: string;
  readonly categoryIds: readonly string[];
}

/** Everything the pricing engine needs besides the cart, read from the synced datasets. */
export interface PricingContext {
  readonly currency: string;
  readonly priceListId: string;
  readonly priceListVersion: number;
  readonly tax: TaxPolicy;
  readonly promotions: readonly Promotion[];
  readonly fees: readonly Fee[];
  readonly cashIncrementMinor: number | undefined;
}

interface Row {
  readonly payload: string;
}

const parse = <T>(r: Row): T => JSON.parse(r.payload) as T; // eslint-disable-line @typescript-eslint/no-unnecessary-type-parameters

interface PriceListPayload {
  readonly priceListId: string;
  readonly currency: string;
  readonly taxRegionId: string;
  readonly branchId: string | null;
  readonly customerGroup: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly cashIncrementMinor: number | null;
  readonly version: number;
  readonly archived: boolean;
}

interface TaxRegionPayload {
  readonly inclusive: boolean;
  readonly strategy: "per-line" | "per-document";
  readonly roundingMode: string;
  readonly rules: TaxPolicy["rules"];
}

interface FeePayload {
  readonly feeId: string;
  readonly name: string;
  readonly kind: Fee["kind"];
  readonly value: number;
  readonly taxCategory: string;
  readonly active: boolean;
}

interface PromotionPayload {
  readonly promotionId: string;
  readonly name: string;
  readonly priority: number;
  readonly stackable: boolean;
  readonly target: PromotionTarget;
  readonly effect: PromotionEffect;
  readonly requiresCoupon: boolean;
  readonly customerGroups: readonly string[] | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly minQty: string | null;
  readonly minAmountMinor: number | null;
}

/** The list for this terminal: not archived, valid now, a branch list beats a tenant-wide one, no customer group. */
export function pickPriceList(
  lists: readonly PriceListPayload[],
  branchId: string,
  nowIso: string,
): PriceListPayload | undefined {
  const live = lists.filter(
    (l) =>
      !l.archived &&
      l.customerGroup === null &&
      (l.branchId === null || l.branchId === branchId) &&
      (l.validFrom === null || l.validFrom <= nowIso) &&
      (l.validTo === null || nowIso < l.validTo),
  );
  return live.find((l) => l.branchId === branchId) ?? live.find((l) => l.branchId === null);
}

export function toPromotion(p: PromotionPayload): Promotion | undefined {
  // A coupon promotion needs the code the cashier types; the code check is online (max uses), so it is not applied offline.
  if (p.requiresCoupon) return undefined;
  return {
    id: p.promotionId,
    name: p.name,
    priority: p.priority,
    stackable: p.stackable,
    target: p.target,
    effect: p.effect,
    ...(p.customerGroups === null ? {} : { customerGroups: p.customerGroups }),
    ...(p.startsAt === null ? {} : { startsAt: p.startsAt }),
    ...(p.endsAt === null ? {} : { endsAt: p.endsAt }),
    ...(p.minQty === null ? {} : { minQty: p.minQty }),
    ...(p.minAmountMinor === null ? {} : { minAmountMinor: p.minAmountMinor }),
  };
}

/**
 * Reads the pricing context and single variants/prices from the local database. Only the small sets (price lists,
 * tax region, fees, promotions) are loaded whole; variants and prices are point reads by primary key, so a 100k-item
 * catalog costs nothing until an item is sold.
 */
export function createSellContext(db: Queryable, branchId: string, now: () => number = Date.now) {
  let ctx: PricingContext | undefined;
  const prices = new Map<string, number>();
  const variants = new Map<string, CatalogVariant>();

  async function load(): Promise<PricingContext | undefined> {
    const nowIso = new Date(now()).toISOString();
    const lists = (
      await db.all<Row>(
        "SELECT payload FROM entities WHERE dataset = 'prices' AND entity = 'price_list'",
      )
    ).map((r) => parse<PriceListPayload>(r));
    const list = pickPriceList(lists, branchId, nowIso);
    if (list === undefined) return undefined;
    const region = await db.get<Row>(
      "SELECT payload FROM entities WHERE dataset = 'tax' AND entity = 'tax_region' AND entity_id = ?",
      [list.taxRegionId],
    );
    if (region === undefined) return undefined;
    const r = parse<TaxRegionPayload>(region);
    const fees = (
      await db.all<Row>("SELECT payload FROM entities WHERE dataset = 'tax' AND entity = 'fee'")
    )
      .map((x) => parse<FeePayload>(x))
      .filter((f) => f.active)
      .map(({ feeId, name, kind, value, taxCategory }) => ({
        id: feeId,
        name,
        kind,
        value,
        taxCategory,
      }));
    const promotions = (
      await db.all<Row>(
        "SELECT payload FROM entities WHERE dataset = 'promotions' AND entity = 'promotion'",
      )
    )
      .map((x) => toPromotion(parse<PromotionPayload>(x)))
      .filter((p): p is Promotion => p !== undefined);
    return {
      currency: list.currency,
      priceListId: list.priceListId,
      priceListVersion: list.version,
      tax: {
        inclusive: r.inclusive,
        strategy: r.strategy,
        mode: r.roundingMode as RoundingMode,
        rules: r.rules,
      },
      promotions,
      fees,
      cashIncrementMinor: list.cashIncrementMinor ?? undefined,
    };
  }

  return {
    /** Re-reads the context (after a sync moved prices, tax or promotions). Memoised prices are dropped. */
    async refresh(): Promise<PricingContext | undefined> {
      ctx = await load();
      prices.clear();
      return ctx;
    },
    get current(): PricingContext | undefined {
      return ctx;
    },

    async variant(variantId: string): Promise<CatalogVariant | undefined> {
      const hit = variants.get(variantId);
      if (hit !== undefined) return hit;
      const row = await db.get<Row>(
        "SELECT payload FROM entities WHERE dataset = 'catalog' AND entity = 'variant' AND entity_id = ?",
        [variantId],
      );
      if (row === undefined) return undefined;
      const v = parse<CatalogVariant>(row);
      variants.set(variantId, v);
      return v;
    },

    /** Reads and remembers the list price of a variant; undefined when the list has none (the item cannot be sold). */
    async price(variantId: string): Promise<number | undefined> {
      if (ctx === undefined) return undefined;
      const known = prices.get(variantId);
      if (known !== undefined) return known;
      const row = await db.get<Row>(
        "SELECT payload FROM entities WHERE dataset = 'prices' AND entity = 'price' AND entity_id = ?",
        [`${ctx.priceListId}:${variantId}`],
      );
      if (row === undefined) return undefined;
      const p = parse<{ priceMinor: number }>(row).priceMinor;
      prices.set(variantId, p);
      return p;
    },

    /** Reads the prices of these variants into the memo (after a refresh dropped it). Variants with no price are returned. */
    async warm(variantIds: readonly string[]): Promise<string[]> {
      const missing: string[] = [];
      for (const id of new Set(variantIds))
        if ((await this.price(id)) === undefined) missing.push(id);
      return missing;
    },

    /** The price map for the engine: only variants already priced (every cart line was priced when it was added). */
    snapshot(): PriceListSnapshot | undefined {
      if (ctx === undefined) return undefined;
      return {
        id: `${ctx.priceListId}:${String(ctx.priceListVersion)}`,
        currency: ctx.currency,
        prices: Object.fromEntries(prices),
      };
    },

    /** Cheap change detector over the datasets the context reads. */
    async fingerprint(): Promise<string> {
      const r = await db.get<{ n: number; m: string | null }>(
        "SELECT count(*) AS n, max(changed_at) AS m FROM entities WHERE dataset IN ('prices', 'tax', 'promotions')",
      );
      return `${String(r?.n ?? 0)}|${r?.m ?? ""}`;
    },
  };
}

export type SellContext = ReturnType<typeof createSellContext>;
