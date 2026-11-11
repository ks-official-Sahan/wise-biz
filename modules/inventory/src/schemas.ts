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

// --- Stock counts (P2-04a) ---

const countId = uuid7;
const CountStatusEnum = z.enum(["draft", "open", "review", "approved", "cancelled"]);
const CountScopeSchema = z
  .object({
    categoryIds: z.array(uuid7).max(50).optional(),
    /** Explicit variants. Strict: an ABC class has no data source yet, so it is refused rather than ignored. */
    variantIds: z.array(uuid7).max(1000).optional(),
  })
  .strict();

export const CreateCountSchema = z
  .object({
    id: countId.optional(),
    locationId: uuid7,
    kind: z.enum(["full", "cycle"]),
    scope: CountScopeSchema.optional(),
    /** Blind: expected quantities are hidden from roles without counts:approve until the count is in review. */
    blind: z.boolean(),
    mode: z.enum(["frozen", "live"]),
    currency: z.string().refine((c) => isCurrency(c), "ISO 4217 code"),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((b, ctx) => {
    const scoped = (b.scope?.categoryIds?.length ?? 0) + (b.scope?.variantIds?.length ?? 0) > 0;
    if (b.kind === "cycle" && !scoped) {
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: "A cycle count needs a category or a variant scope.",
      });
    }
    if (b.kind === "full" && scoped) {
      ctx.addIssue({ code: "custom", path: ["scope"], message: "A full count takes no scope." });
    }
  })
  .openapi("CreateCount");

export const CountVersionSchema = z
  .object({ version: z.number().int().min(1) })
  .openapi("CountVersion");

export const CloseCountSchema = z
  .object({
    version: z.number().int().min(1),
    /** Explicit operator choice: lines nobody counted are booked as counted zero. Default: they block approval. */
    zeroUncounted: z.boolean().optional(),
  })
  .openapi("CloseCount");

export const RecountSchema = z
  .object({
    version: z.number().int().min(1),
    lines: z
      .array(
        z.object({
          variantId: uuid7,
          batchId: uuid7.nullable().optional(),
          note: z.string().trim().max(500).optional(),
        }),
      )
      .min(1)
      .max(200),
  })
  .openapi("RequestRecount");

export const ScansSchema = z
  .object({
    deviceId: uuid7.optional(),
    scans: z
      .array(
        z.object({
          /** One id per device scan (UUIDv7 from the device): a replayed scan is ignored. */
          id: uuid7,
          variantId: uuid7,
          batchId: uuid7.nullable().optional(),
          qty: positive,
          scannedAt: z.iso.datetime({ offset: true }),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((b, ctx) => {
    if (new Set(b.scans.map((s) => s.id)).size !== b.scans.length) {
      ctx.addIssue({ code: "custom", path: ["scans"], message: "duplicate scan id" });
    }
  })
  .openapi("CountScans");

export const CountListQuerySchema = z.object({
  status: CountStatusEnum.optional(),
  after: countId.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const CountLinesQuerySchema = z.object({
  /** Keyset cursor "variantId|batchId" (nil batch = no batch), as returned by nextCursor. */
  after: z
    .string()
    .regex(new RegExp(`^${UUID_TEXT}\\|${UUID_TEXT}$`))
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const CountHeaderSchema = z
  .object({
    id: z.string(),
    locationId: z.string(),
    kind: z.enum(["full", "cycle"]),
    scope: z.object({ categoryIds: z.array(z.string()), variantCount: z.number().int() }),
    blind: z.boolean(),
    mode: z.enum(["frozen", "live"]),
    status: CountStatusEnum,
    currency: z.string(),
    note: z.string(),
    version: z.number().int(),
    lineCount: z.number().int(),
    countedLineCount: z.number().int(),
    openedAt: z.string(),
    startedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    approvedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
  })
  .openapi("Count");

const CountLineSchema = z
  .object({
    variantId: z.string(),
    batchId: z.string().nullable(),
    round: z.number().int(),
    countedQty: z.string().nullable(),
    recountRequested: z.boolean(),
    note: z.string(),
    /** Hidden (null) for blind counts unless the caller may approve. */
    expectedQty: z.string().nullable(),
    closeQty: z.string().nullable(),
  })
  .openapi("CountLine");

export const CountDetailSchema = z
  .object({
    count: CountHeaderSchema,
    lines: z.array(CountLineSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi("CountDetail");

export const CountPageSchema = z
  .object({ items: z.array(CountHeaderSchema), nextCursor: z.string().nullable() })
  .openapi("CountPage");

export const CountScanResultSchema = z
  .object({ accepted: z.number().int(), duplicates: z.number().int() })
  .openapi("CountScanResult");

export const VarianceSchema = z
  .object({
    count: CountHeaderSchema,
    /** Expected, variance and value are null for blind counts unless the caller may approve. */
    lines: z.array(
      z.object({
        variantId: z.string(),
        batchId: z.string().nullable(),
        countedQty: z.string().nullable(),
        expectedQty: z.string().nullable(),
        varianceQty: z.string().nullable(),
        unitCostMinor: z.number().int().nullable(),
        valueMinor: z.number().int().nullable(),
      }),
    ),
    totals: z.object({
      shortValueMinor: z.number().int().nullable(),
      overValueMinor: z.number().int().nullable(),
      unvaluedLines: z.number().int(),
    }),
  })
  .openapi("CountVariance");

// --- Stock-gap cases (P2-04b) ---

const caseId = uuid7;
const GapStatusEnum = z.enum(["open", "investigating", "resolved"]);
export const RESOLUTION_CODE_ENUM = [
  "theft",
  "damage",
  "data_error",
  "misplaced_found",
  "supplier_short",
] as const;
const ResolutionEnum = z.enum(RESOLUTION_CODE_ENUM);

/** Thresholds of a case run: either or both. A line over either becomes a case (see domain/gap.ts isGapCase). */
export const GenerateGapsSchema = z
  .object({
    minQty: qtyOrZero.optional(),
    minValueMinor: minor.optional(),
  })
  .superRefine((b, ctx) => {
    if (b.minQty === undefined && b.minValueMinor === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["minQty"],
        message: "Give minQty, minValueMinor or both.",
      });
    }
  })
  .openapi("GenerateGaps");

export const UpdateGapSchema = z
  .object({
    version: z.number().int().min(1),
    status: z.literal("investigating").optional(),
    assigneeId: uuid7.nullable().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.status === undefined && b.assigneeId === undefined) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "Nothing to change." });
    }
  })
  .openapi("UpdateGap");

export const CreateGapTaskSchema = z
  .object({
    version: z.number().int().min(1),
    title: z.string().trim().min(1).max(200),
    assigneeId: uuid7.nullable().optional(),
  })
  .openapi("CreateGapTask");

export const UpdateGapTaskSchema = z
  .object({
    version: z.number().int().min(1),
    done: z.boolean().optional(),
    assigneeId: uuid7.nullable().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.done === undefined && b.assigneeId === undefined) {
      ctx.addIssue({ code: "custom", path: ["done"], message: "Nothing to change." });
    }
  })
  .openapi("UpdateGapTask");

export const ResolveGapSchema = z
  .object({
    version: z.number().int().min(1),
    code: ResolutionEnum,
    note: z.string().trim().max(500).optional(),
    /** misplaced_found only: where the stock was found, and how much (at most the shortage). */
    foundLocationId: uuid7.optional(),
    foundQty: positive.optional(),
  })
  .superRefine((b, ctx) => {
    const misplaced = b.code === "misplaced_found";
    if (misplaced && (b.foundLocationId === undefined || b.foundQty === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["foundLocationId"],
        message: "A misplaced-found resolution needs foundLocationId and foundQty.",
      });
    }
    if (!misplaced && (b.foundLocationId !== undefined || b.foundQty !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["foundLocationId"],
        message: "Only a misplaced-found resolution takes a location and quantity.",
      });
    }
  })
  .openapi("ResolveGap");

export const GapListQuerySchema = z.object({
  status: GapStatusEnum.optional(),
  assigneeId: uuid7.optional(),
  after: caseId.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GapCaseSchema = z
  .object({
    id: z.string(),
    countId: z.string(),
    locationId: z.string(),
    variantId: z.string(),
    batchId: z.string().nullable(),
    currency: z.string(),
    varianceQty: z.string(),
    unitCostMinor: z.number().int().nullable(),
    valueMinor: z.number().int().nullable(),
    windowFrom: z.string(),
    windowTo: z.string(),
    status: GapStatusEnum,
    assigneeId: z.string().nullable(),
    resolutionCode: ResolutionEnum.nullable(),
    resolutionNote: z.string(),
    foundLocationId: z.string().nullable(),
    foundQty: z.string().nullable(),
    version: z.number().int(),
    taskCount: z.number().int(),
    openTaskCount: z.number().int(),
    openedAt: z.string(),
    resolvedAt: z.string().nullable(),
  })
  .openapi("GapCase");

const GapTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    assigneeId: z.string().nullable(),
    done: z.boolean(),
    doneAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("GapTask");

const GapEvidenceItemSchema = z.object({
  source: z.string(),
  kind: z.string(),
  locationId: z.string(),
  variantId: z.string().nullable(),
  occurredAt: z.string(),
  qty: z.string().nullable(),
  actorId: z.string().nullable(),
  ref: z.string(),
});

export const GapEvidenceSchema = z
  .object({
    /** Ordered newest first, bounded: `truncated` is true when more events fell in the window. */
    items: z.array(GapEvidenceItemSchema),
    truncated: z.boolean(),
    /** Evidence sources that are not wired yet (their events are missing, not zero). */
    unavailable: z.array(z.string()),
  })
  .openapi("GapEvidence");

export const GapCaseDetailSchema = z
  .object({
    case: GapCaseSchema,
    tasks: z.array(GapTaskSchema),
    evidence: GapEvidenceSchema,
  })
  .openapi("GapCaseDetail");

export const GapCasePageSchema = z
  .object({ items: z.array(GapCaseSchema), nextCursor: z.string().nullable() })
  .openapi("GapCasePage");

export const GapGenerateResultSchema = z
  .object({
    countId: z.string(),
    /** Cases created by this call. A replay creates none. */
    created: z.number().int(),
    /** Lines over the thresholds that already had a case. */
    existing: z.number().int(),
  })
  .openapi("GapGenerateResult");

export const GapTaskResultSchema = z
  .object({ task: GapTaskSchema, case: GapCaseSchema })
  .openapi("GapTaskResult");
