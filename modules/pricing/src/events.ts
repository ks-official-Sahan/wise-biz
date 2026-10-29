import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/** events.md: one topic keyed by tenant, so a list's price changes arrive in order after the list itself. */
export const PRICING_TOPIC = "pricing";

const nullableIso = z.string().nullable();

export const PriceListUpsertedV1 = defineEvent(
  "pricing.price_list.upserted",
  1,
  z.object({
    priceListId: z.string(),
    name: z.string(),
    currency: z.string(),
    taxRegionId: z.string(),
    branchId: z.string().nullable(),
    customerGroup: z.string().nullable(),
    validFrom: nullableIso,
    validTo: nullableIso,
    cashIncrementMinor: z.number().int().nullable(),
    version: z.number().int(),
    archived: z.boolean(),
  }),
);

/** Changed prices only (null = removed from the list). `version` is the list's new snapshot version. */
export const PriceChangedV1 = defineEvent(
  "pricing.price.changed",
  1,
  z.object({
    priceListId: z.string(),
    version: z.number().int(),
    changes: z.array(z.object({ variantId: z.string(), priceMinor: z.number().int().nullable() })),
  }),
);

/** The whole region with its rules: devices replace their copy. */
export const TaxRegionUpsertedV1 = defineEvent(
  "pricing.tax_region.upserted",
  1,
  z.object({
    taxRegionId: z.string(),
    code: z.string(),
    name: z.string(),
    inclusive: z.boolean(),
    strategy: z.enum(["per-line", "per-document"]),
    roundingMode: z.string(),
    version: z.number().int(),
    rules: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        rateBps: z.number().int(),
        compound: z.boolean(),
        categories: z.array(z.string()),
        order: z.number().int(),
      }),
    ),
  }),
);

export const FeeUpsertedV1 = defineEvent(
  "pricing.fee.upserted",
  1,
  z.object({
    feeId: z.string(),
    name: z.string(),
    kind: z.enum(["percent", "amount"]),
    value: z.number().int(),
    taxCategory: z.string(),
    active: z.boolean(),
    version: z.number().int(),
  }),
);

/** The engine's Promotion shape plus the coupon flag, so a device can price offline from this payload alone. */
export const PromotionPublishedV1 = defineEvent(
  "pricing.promotion.published",
  1,
  z.object({
    promotionId: z.string(),
    name: z.string(),
    priority: z.number().int(),
    stackable: z.boolean(),
    target: z.unknown(),
    effect: z.unknown(),
    requiresCoupon: z.boolean(),
    customerGroups: z.array(z.string()).nullable(),
    startsAt: nullableIso,
    endsAt: nullableIso,
    minQty: z.string().nullable(),
    minAmountMinor: z.number().int().nullable(),
    version: z.number().int(),
  }),
);

export const PromotionArchivedV1 = defineEvent(
  "pricing.promotion.archived",
  1,
  z.object({ promotionId: z.string(), version: z.number().int() }),
);

export const FxRateRecordedV1 = defineEvent(
  "pricing.fx_rate.recorded",
  1,
  z.object({
    fxRateId: z.string(),
    base: z.string(),
    quote: z.string(),
    /** Decimal string (numeric(20,10)): never a float on the wire. */
    rate: z.string(),
    validFrom: z.string(),
  }),
);

export const PRICING_EVENTS = [
  PriceListUpsertedV1,
  PriceChangedV1,
  TaxRegionUpsertedV1,
  FeeUpsertedV1,
  PromotionPublishedV1,
  PromotionArchivedV1,
  FxRateRecordedV1,
] as const;
