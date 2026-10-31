import { z } from "@hono/zod-openapi";
import { isCurrency } from "@wise-biz/money";

export const uuid7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUIDv7");
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.iso.date();
const positive = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "decimal, up to 4 places")
  .refine((s) => /[1-9]/.test(s), "must be > 0");
const signed = z
  .string()
  .regex(/^-?\d{1,14}(\.\d{1,4})?$/, "signed decimal, up to 4 places")
  .refine((s) => /[1-9]/.test(s), "must not be 0");
const qtyOrZero = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, "decimal, up to 4 places");

export const ReceiveSchema = z
  .object({
    id: uuid7.optional(),
    locationId: uuid7,
    supplierId: uuid7.optional(),
    purchaseOrderId: uuid7.optional(),
    reference: z.string().trim().min(1).max(64).optional(),
    currency: z.string().refine((c) => isCurrency(c), "ISO 4217 code"),
    receivedAt: z.iso.datetime({ offset: true }).optional(),
    lines: z
      .array(
        z.object({
          variantId: uuid7,
          qty: positive,
          unitCostMinor: minor,
          lotCode: z.string().trim().min(1).max(64).optional(),
          expiresOn: date.optional(),
          salePriceMinor: minor.optional(),
        }),
      )
      .min(1)
      .max(500),
  })
  .openapi("Receive");

const Balance = z.object({
  locationId: z.string(),
  variantId: z.string(),
  batchId: z.string().nullable(),
  qty: z.string(),
  reserved: z.string(),
});
export const ReceiptSchema = z
  .object({
    id: z.string(),
    locationId: z.string(),
    currency: z.string(),
    receivedAt: z.string(),
    lines: z.array(
      z.object({
        line: z.number().int(),
        variantId: z.string(),
        batchId: z.string().nullable(),
        qty: z.string(),
        unitCostMinor: z.number().int(),
      }),
    ),
    balances: z.array(Balance),
  })
  .openapi("Receipt");

export const ADJUST_REASONS = [
  "damage",
  "theft",
  "loss",
  "found",
  "count_correction",
  "expiry",
  "writeoff",
  "sample",
  "other",
] as const;
export const AdjustSchema = z
  .object({
    id: uuid7.optional(),
    locationId: uuid7,
    reason: z.enum(ADJUST_REASONS),
    note: z.string().trim().min(1).max(500).optional(),
    lines: z
      .array(z.object({ variantId: uuid7, batchId: uuid7.nullable().optional(), qty: signed }))
      .min(1)
      .max(500)
      .refine(
        (ls) => new Set(ls.map((l) => `${l.variantId}|${l.batchId ?? ""}`)).size === ls.length,
        "one line per variant and batch",
      ),
  })
  .refine((a) => a.reason !== "other" || a.note !== undefined, {
    path: ["note"],
    message: "required for other",
  })
  .openapi("Adjust");
export const AdjustmentSchema = z
  .object({
    id: z.string(),
    locationId: z.string(),
    reason: z.enum(ADJUST_REASONS),
    valueMinor: z.number().int(),
    balances: z.array(Balance),
  })
  .openapi("Adjustment");

export const BalancesQuerySchema = z
  .object({
    locationId: uuid7.optional(),
    variantId: uuid7.optional(),
    byBatch: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    expiringBefore: date.optional(),
    after: z
      .string()
      .regex(/^[0-9a-f-]{36}\|[0-9a-f-]{36}(\|[0-9a-f-]{36})?$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .refine((q) => q.locationId !== undefined || q.variantId !== undefined, {
    path: ["locationId"],
    message: "locationId or variantId is required",
  });
export const BalancePageSchema = z
  .object({
    items: z.array(
      Balance.extend({
        available: z.string(),
        lotCode: z.string().nullable().optional(),
        expiresOn: z.string().nullable().optional(),
        salePriceMinor: z.number().int().nullable().optional(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .openapi("BalancePage");

export const MovementsQuerySchema = z.object({
  variantId: uuid7,
  locationId: uuid7.optional(),
  before: z
    .string()
    .regex(/^[^|]{20,40}\|[0-9a-f-]{36}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const MovementPageSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        locationId: z.string(),
        batchId: z.string().nullable(),
        qty: z.string(),
        reason: z.string(),
        sourceType: z.string(),
        sourceId: z.string(),
        unitCostMinor: z.number().int().nullable(),
        occurredAt: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .openapi("MovementPage");

export const BatchSchema = z
  .object({
    id: z.string(),
    variantId: z.string(),
    lotCode: z.string().nullable(),
    expiresOn: z.string().nullable(),
    currency: z.string(),
    unitCostMinor: z.number().int(),
    salePriceMinor: z.number().int().nullable(),
    receivedAt: z.string().nullable(),
  })
  .openapi("Batch");
export const UpdateBatchSchema = z
  .object({ salePriceMinor: minor.nullable() })
  .openapi("UpdateBatch");

export const SetThresholdsSchema = z
  .object({
    locationId: uuid7,
    items: z
      .array(
        z
          .object({
            variantId: uuid7,
            minQty: qtyOrZero.nullable(),
            maxQty: qtyOrZero.nullable().optional(),
          })
          .refine(
            (t) => t.minQty === null || t.maxQty == null || Number(t.maxQty) >= Number(t.minQty),
            {
              path: ["maxQty"],
              message: "must be >= minQty",
            },
          ),
      )
      .min(1)
      .max(1000)
      .refine(
        (ts) => new Set(ts.map((t) => t.variantId)).size === ts.length,
        "duplicate variantId",
      ),
  })
  .openapi("SetThresholds");
export const ThresholdSchema = z
  .object({
    locationId: z.string(),
    variantId: z.string(),
    minQty: z.string(),
    maxQty: z.string().nullable(),
    lowSince: z.string().nullable(),
  })
  .openapi("Threshold");
