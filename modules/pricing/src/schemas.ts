import { z } from "@hono/zod-openapi";
import { isCurrency } from "@wise-biz/money";

export const uuid7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUIDv7");
const name = (max: number) => z.string().trim().min(1).max(max);
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bps = z.number().int().min(0).max(10_000);
const iso = z.iso.datetime({ offset: true });
const qty = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, "decimal, up to 4 places");
const taxCategory = z
  .string()
  .trim()
  .regex(/^(\*|[a-z0-9_.-]{1,40})$/, "lowercase code");
const currency = z
  .string()
  .refine((c) => isCurrency(c), "ISO 4217 code")
  .openapi({ example: "LKR" });
const window = (v: {
  validFrom?: string | null | undefined;
  validTo?: string | null | undefined;
}) => v.validFrom == null || v.validTo == null || v.validTo > v.validFrom;

// --- Tax regions ---

const TaxRuleInputSchema = z.object({
  id: uuid7.optional(),
  name: name(60),
  rateBps: z.number().int().min(0).max(100_000),
  compound: z.boolean().default(false),
  categories: z.array(taxCategory).min(1).max(50),
  order: z.number().int().min(0).max(99),
});
const RoundingModeSchema = z.enum(["half-even", "half-up", "up", "down"]);

export const CreateTaxRegionSchema = z
  .object({
    id: uuid7.optional(),
    code: z.string().regex(/^[a-z0-9_.-]{1,32}$/),
    name: name(120),
    inclusive: z.boolean(),
    strategy: z.enum(["per-line", "per-document"]),
    roundingMode: RoundingModeSchema.default("half-even"),
    rules: z.array(TaxRuleInputSchema).max(20),
  })
  .openapi("CreateTaxRegion");
export const UpdateTaxRegionSchema = CreateTaxRegionSchema.omit({ id: true, code: true })
  .extend({ version: z.number().int().min(1) })
  .openapi("UpdateTaxRegion");
export const TaxRegionSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    inclusive: z.boolean(),
    strategy: z.enum(["per-line", "per-document"]),
    roundingMode: RoundingModeSchema,
    version: z.number().int(),
    rules: z.array(TaxRuleInputSchema.required({ id: true })),
  })
  .openapi("TaxRegion");

// --- Price lists and prices ---

export const CreatePriceListSchema = z
  .object({
    id: uuid7.optional(),
    name: name(120),
    currency,
    taxRegionId: uuid7,
    branchId: uuid7.nullable().optional(),
    customerGroup: name(60).nullable().optional(),
    validFrom: iso.nullable().optional(),
    validTo: iso.nullable().optional(),
    cashIncrementMinor: z.number().int().min(1).max(100_000).nullable().optional(),
  })
  .refine(window, { path: ["validTo"], message: "must be after validFrom" })
  .openapi("CreatePriceList");
export const UpdatePriceListSchema = z
  .object({
    version: z.number().int().min(1),
    name: name(120).optional(),
    taxRegionId: uuid7.optional(),
    branchId: uuid7.nullable().optional(),
    customerGroup: name(60).nullable().optional(),
    validFrom: iso.nullable().optional(),
    validTo: iso.nullable().optional(),
    cashIncrementMinor: z.number().int().min(1).max(100_000).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(window, { path: ["validTo"], message: "must be after validFrom" })
  .openapi("UpdatePriceList");
export const PriceListSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    currency: z.string(),
    taxRegionId: z.string(),
    branchId: z.string().nullable(),
    customerGroup: z.string().nullable(),
    validFrom: z.string().nullable(),
    validTo: z.string().nullable(),
    cashIncrementMinor: z.number().int().nullable(),
    version: z.number().int(),
    archived: z.boolean(),
  })
  .openapi("PriceList");

export const SetPricesSchema = z
  .object({
    /** The list's current version (optimistic lock: two editors never overwrite each other's batch). */
    version: z.number().int().min(1),
    prices: z
      .array(z.object({ variantId: uuid7, priceMinor: minor.nullable() }))
      .min(1)
      .max(1000)
      .refine(
        (ps) => new Set(ps.map((p) => p.variantId)).size === ps.length,
        "duplicate variantId",
      ),
  })
  .openapi("SetPrices");
export const PricePageSchema = z
  .object({
    items: z.array(z.object({ variantId: z.string(), priceMinor: z.number().int() })),
    nextCursor: z.string().nullable(),
  })
  .openapi("PricePage");

// --- Fees ---

const feeValue = (f: { kind?: "percent" | "amount" | undefined; value?: number | undefined }) =>
  f.kind !== "percent" || f.value === undefined || f.value <= 10_000;
export const CreateFeeSchema = z
  .object({
    id: uuid7.optional(),
    name: name(60),
    kind: z.enum(["percent", "amount"]),
    value: minor,
    taxCategory,
    active: z.boolean().default(true),
  })
  .refine(feeValue, { path: ["value"], message: "percent fees are basis points (max 10000)" })
  .openapi("CreateFee");
export const UpdateFeeSchema = z
  .object({
    version: z.number().int().min(1),
    name: name(60).optional(),
    kind: z.enum(["percent", "amount"]).optional(),
    value: minor.optional(),
    taxCategory: taxCategory.optional(),
    active: z.boolean().optional(),
  })
  .openapi("UpdateFee");
export const FeeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["percent", "amount"]),
    value: z.number().int(),
    taxCategory: z.string(),
    active: z.boolean(),
    version: z.number().int(),
  })
  .openapi("Fee");

// --- Promotions (target and effect mirror @wise-biz/pricing-engine) ---

const ids = z.array(uuid7).min(1).max(500);
export const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cart") }),
  z.object({
    kind: z.literal("items"),
    variantIds: ids.optional(),
    categoryIds: ids.optional(),
  }),
]);
export const EffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("percent"), bps }),
  z.object({ kind: z.literal("amount"), amountMinor: minor }),
  z.object({ kind: z.literal("fixed-price"), unitPriceMinor: minor }),
  z.object({
    kind: z.literal("bxgy"),
    buy: z.number().int().min(1).max(100),
    get: z.number().int().min(1).max(100),
    getBps: bps,
  }),
  z.object({
    kind: z.literal("bundle"),
    components: z
      .array(z.object({ variantId: uuid7, qty: z.number().int().min(1).max(100) }))
      .min(1)
      .max(20)
      .refine((cs) => new Set(cs.map((c) => c.variantId)).size === cs.length, "duplicate variant"),
    priceMinor: minor,
  }),
]);
const promoFields = {
  name: name(120),
  priority: z.number().int().min(-1000).max(1000),
  stackable: z.boolean(),
  target: TargetSchema,
  effect: EffectSchema,
  requiresCoupon: z.boolean(),
  customerGroups: z.array(name(60)).min(1).max(20).nullable(),
  startsAt: iso.nullable(),
  endsAt: iso.nullable(),
  minQty: qty.nullable(),
  minAmountMinor: minor.nullable(),
};
const promoWindow = (p: {
  startsAt?: string | null | undefined;
  endsAt?: string | null | undefined;
}) => p.startsAt == null || p.endsAt == null || p.endsAt > p.startsAt;
/** Cart-level promotions take percent or amount (bundles ignore the target): engine rules. */
const promoShape = (p: { target: { kind: string }; effect: { kind: string } }) =>
  p.target.kind !== "cart" || ["percent", "amount", "bundle"].includes(p.effect.kind);

/** Also re-checks a draft after a partial update (merged with the stored row). */
export const CreatePromotionSchema = z
  .object({
    ...promoFields,
    id: uuid7.optional(),
    priority: promoFields.priority.default(0),
    stackable: promoFields.stackable.default(true),
    requiresCoupon: promoFields.requiresCoupon.default(false),
    customerGroups: promoFields.customerGroups.optional(),
    startsAt: promoFields.startsAt.optional(),
    endsAt: promoFields.endsAt.optional(),
    minQty: promoFields.minQty.optional(),
    minAmountMinor: promoFields.minAmountMinor.optional(),
  })
  .refine(promoWindow, { path: ["endsAt"], message: "must be after startsAt" })
  .refine(promoShape, { path: ["effect"], message: "cart promotions take percent or amount" })
  .openapi("CreatePromotion");
/** Drafts only. Omitted fields keep their value (no defaults here). */
export const UpdatePromotionSchema = z
  .object(promoFields)
  .partial()
  .extend({ version: z.number().int().min(1) })
  .openapi("UpdatePromotion");
export const VersionSchema = z.object({ version: z.number().int().min(1) }).openapi("Version");
export const PromotionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(["draft", "published", "archived"]),
    priority: z.number().int(),
    stackable: z.boolean(),
    target: TargetSchema,
    effect: EffectSchema,
    requiresCoupon: z.boolean(),
    customerGroups: z.array(z.string()).nullable(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    minQty: z.string().nullable(),
    minAmountMinor: z.number().int().nullable(),
    version: z.number().int(),
    publishedAt: z.string().nullable(),
  })
  .openapi("Promotion");

export const CreateCouponSchema = z
  .object({
    id: uuid7.optional(),
    code: z.string().regex(/^[A-Za-z0-9_-]{3,32}$/),
    maxUses: z.number().int().min(1).nullable().optional(),
  })
  .openapi("CreateCoupon");
export const CouponSchema = z
  .object({
    id: z.string(),
    promotionId: z.string(),
    code: z.string(),
    maxUses: z.number().int().nullable(),
    uses: z.number().int(),
    active: z.boolean(),
  })
  .openapi("Coupon");

// --- FX ---

export const CreateFxRateSchema = z
  .object({
    id: uuid7.optional(),
    base: currency,
    quote: currency,
    /** Decimal string, up to 10 places (1 base = rate quote). */
    rate: z.string().regex(/^(?!0+(\.0+)?$)\d{1,10}(\.\d{1,10})?$/, "positive decimal"),
    validFrom: iso.optional(),
  })
  .refine((r) => r.base !== r.quote, { path: ["quote"], message: "must differ from base" })
  .openapi("CreateFxRate");
export const FxRateSchema = z
  .object({
    id: z.string(),
    base: z.string(),
    quote: z.string(),
    rate: z.string(),
    validFrom: z.string(),
    source: z.string(),
  })
  .openapi("FxRate");

// --- Quote ---

export const QuoteSchema = z
  .object({
    priceListId: uuid7,
    lines: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          variantId: uuid7,
          qty,
          priceOverrideMinor: minor.optional(),
        }),
      )
      .max(500),
    coupons: z.array(z.string().min(1).max(32)).max(10).optional(),
    customerGroup: name(60).optional(),
  })
  .openapi("QuoteRequest");

const int = z.number().int();
const Applied = z.object({ promotionId: z.string(), amountMinor: int });
export const QuoteResponseSchema = z
  .object({
    engine: z.string(),
    currency: z.string(),
    /** `<priceListId>:<version>`: the snapshot the cart was priced with. */
    priceListId: z.string(),
    lines: z.array(
      z.object({
        id: z.string(),
        variantId: z.string(),
        qty: z.string(),
        unitPriceMinor: int,
        priceSource: z.enum(["override", "batch", "list"]),
        baseMinor: int,
        lineDiscounts: z.array(Applied),
        cartDiscounts: z.array(Applied),
        amountMinor: int,
        netMinor: int,
        taxMinor: int,
        taxes: z.array(z.object({ ruleId: z.string(), amountMinor: int })),
        totalMinor: int,
      }),
    ),
    fees: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        amountMinor: int,
        netMinor: int,
        taxMinor: int,
        totalMinor: int,
      }),
    ),
    taxes: z.array(
      z.object({
        ruleId: z.string(),
        name: z.string(),
        rateBps: int,
        baseMinor: int,
        amountMinor: int,
      }),
    ),
    subtotalMinor: int,
    discountMinor: int,
    feeMinor: int,
    taxMinor: int,
    totalMinor: int,
    cashRoundingMinor: int,
    payableMinor: int,
    trace: z.array(z.string()),
    coupons: z.array(
      z.object({
        code: z.string(),
        status: z.enum(["applied", "unknown", "inactive", "exhausted"]),
      }),
    ),
  })
  .openapi("Quote");
