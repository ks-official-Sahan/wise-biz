import { z } from "zod";

/**
 * Terminal commands, shared by the POS (which creates them) and the server (which applies them). The transport (P1-06)
 * verifies signature and chain continuity; handlers store `meta` with the document. Money is integer minor units,
 * quantities are decimal strings in the base unit. Never add a float.
 */
const uuid7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUIDv7");
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const signedMinor = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const qty = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, "decimal, up to 4 places")
  .refine((s) => /[1-9]/.test(s), "must be > 0");
const currency = z.string().regex(/^[A-Z]{3}$/);
const instant = z.iso.datetime({ offset: true });
const base64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .max(512);
const reason = z.string().trim().min(1).max(500);

/** Filled by the device for every signed document (offline-sync.md, Up: command outbox). */
export const CommandMetaSchema = z.object({
  deviceSeq: z.number().int().min(0),
  prevHash: base64,
  hash: base64,
  signature: base64,
});
export type CommandMeta = z.output<typeof CommandMetaSchema>;

export const TENDER_KINDS = [
  "cash",
  "card",
  "wallet",
  "bank_transfer",
  "voucher",
  "store_credit",
  "other",
] as const;

const TenderSchema = z
  .object({
    id: uuid7,
    kind: z.enum(TENDER_KINDS),
    /** Applied to the sale, in the sale currency. Change is already taken out. */
    amountMinor: minor,
    /** Cash handed over and change returned; for the drawer count. */
    receivedMinor: minor.optional(),
    changeMinor: minor.optional(),
    /** Foreign-currency tender (data-model.md, Multi-currency). */
    foreign: z
      .object({ currency, amountMinor: minor, fxRate: z.string().regex(/^\d{1,10}(\.\d{1,10})?$/) })
      .optional(),
    /** Card tender as reported by the terminal: never a PAN, never a CVV. */
    card: z
      .object({
        provider: z.string().trim().min(1).max(40),
        providerRef: z.string().trim().min(1).max(120).optional(),
        authCode: z.string().trim().min(1).max(20).optional(),
        last4: z
          .string()
          .regex(/^\d{4}$/)
          .optional(),
        brand: z.string().trim().min(1).max(20).optional(),
      })
      .optional(),
  })
  .refine((t) => t.kind !== "card" || t.card !== undefined, {
    path: ["card"],
    message: "required for card",
  });

const SaleLineSchema = z.object({
  variantId: uuid7,
  /** Snapshots: reports never re-join current names or prices. */
  name: z.string().trim().min(1).max(250),
  sku: z.string().trim().min(1).max(64),
  locationId: uuid7,
  batchId: uuid7.nullable().optional(),
  qty,
  unitPriceMinor: minor,
  priceSource: z.enum(["override", "batch", "list"]),
  discountMinor: minor,
  taxMinor: minor,
  totalMinor: minor,
  /** Engine detail (discount reasons, per-rule taxes), kept verbatim for receipts and support. Never in events. */
  detail: z
    .record(z.string(), z.unknown())
    .refine((d) => JSON.stringify(d).length <= 2048, "at most 2 KB")
    .optional(),
});

export const CompleteSaleSchema = z
  .object({
    id: uuid7,
    shiftId: uuid7,
    operatorId: uuid7,
    customerId: uuid7.nullable().optional(),
    saleNo: z.number().int().min(1),
    currency,
    businessDate: z.iso.date(),
    completedAt: instant,
    /** What priced it on the device: decides whether the server can re-price (ADR 0014). */
    priceListId: uuid7,
    priceListVersion: z.number().int().min(1),
    engineVersion: z.string().min(1).max(20),
    policyVersion: z.number().int().min(0),
    /** Promotions the engine applied on the device: part of "same pricing inputs" (only then can a sale be rejected). */
    promotionIds: z.array(uuid7).max(50).default([]),
    coupons: z.array(z.string().min(1).max(32)).max(10).optional(),
    customerGroup: z.string().trim().min(1).max(60).optional(),
    lines: z.array(SaleLineSchema).min(1).max(500),
    tenders: z.array(TenderSchema).min(1).max(20),
    subtotalMinor: minor,
    discountMinor: minor,
    feeMinor: minor,
    taxMinor: minor,
    totalMinor: minor,
    cashRoundingMinor: signedMinor,
    payableMinor: minor,
    meta: CommandMetaSchema,
  })
  .refine((s) => s.tenders.reduce((a, t) => a + t.amountMinor, 0) === s.payableMinor, {
    path: ["tenders"],
    message: "tenders must add up to the payable amount",
  })
  .refine((s) => s.lines.reduce((a, l) => a + l.totalMinor, 0) <= s.totalMinor, {
    path: ["lines"],
    message: "lines cannot exceed the total",
  });
export type CompleteSale = z.output<typeof CompleteSaleSchema>;

export const OpenShiftSchema = z.object({
  id: uuid7,
  operatorId: uuid7,
  businessDate: z.iso.date(),
  openedAt: instant,
  currency,
  openingFloatMinor: minor,
  meta: CommandMetaSchema,
});
export type OpenShift = z.output<typeof OpenShiftSchema>;

export const CloseShiftSchema = z.object({
  id: uuid7,
  operatorId: uuid7,
  closedAt: instant,
  /** What the operator counted; the expected amount is computed by the server. */
  countedCashMinor: minor,
  blindCount: z.boolean().default(false),
  note: reason.optional(),
  meta: CommandMetaSchema,
});
export type CloseShift = z.output<typeof CloseShiftSchema>;

export const OpenDrawerSchema = z.object({
  id: uuid7,
  shiftId: uuid7,
  operatorId: uuid7,
  openedAt: instant,
  reason,
  saleId: uuid7.nullable().optional(),
  meta: CommandMetaSchema,
});
export type OpenDrawer = z.output<typeof OpenDrawerSchema>;

export const CashMovementSchema = z.object({
  id: uuid7,
  shiftId: uuid7,
  operatorId: uuid7,
  kind: z.enum(["pay_in", "pay_out", "float_add", "drop"]),
  amountMinor: minor.refine((v) => v > 0, "must be > 0"),
  occurredAt: instant,
  reason,
  meta: CommandMetaSchema,
});
export type CashMovement = z.output<typeof CashMovementSchema>;

export const RecordOverrideSchema = z.object({
  id: uuid7,
  requesterId: uuid7,
  approverId: uuid7,
  permission: z.string().regex(/^[a-z_]+:[a-z_]+$/),
  reason,
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  /** The document it applied to, when known. */
  subjectType: z.enum(["sale", "return", "void", "shift", "drawer"]).optional(),
  subjectId: uuid7.optional(),
  occurredAt: instant,
  meta: CommandMetaSchema,
});
export type RecordOverride = z.output<typeof RecordOverrideSchema>;

export const VoidSaleSchema = z.object({
  id: uuid7,
  saleId: uuid7,
  shiftId: uuid7,
  operatorId: uuid7,
  occurredAt: instant,
  reason,
  /** RecordOverride that allowed a void past the policy window. */
  overrideId: uuid7.optional(),
  meta: CommandMetaSchema,
});
export type VoidSale = z.output<typeof VoidSaleSchema>;

export const CompleteReturnSchema = z
  .object({
    id: uuid7,
    /** Null: no-receipt return (needs an override). */
    saleId: uuid7.nullable(),
    shiftId: uuid7,
    operatorId: uuid7,
    returnNo: z.number().int().min(1),
    currency,
    businessDate: z.iso.date(),
    occurredAt: instant,
    reason,
    overrideId: uuid7.optional(),
    lines: z
      .array(
        z.object({
          /** The original sale line; required unless no-receipt. */
          saleLine: z.number().int().min(0).optional(),
          variantId: uuid7,
          name: z.string().trim().min(1).max(250),
          sku: z.string().trim().min(1).max(64),
          locationId: uuid7,
          batchId: uuid7.nullable().optional(),
          qty,
          refundMinor: minor,
          taxMinor: minor,
          /** restock: back to the location. writeoff: recorded, not sellable. */
          disposition: z.enum(["restock", "writeoff"]),
        }),
      )
      .min(1)
      .max(500),
    tenders: z.array(TenderSchema).min(1).max(20),
    totalMinor: minor,
    meta: CommandMetaSchema,
  })
  .refine((r) => r.tenders.reduce((a, t) => a + t.amountMinor, 0) === r.totalMinor, {
    path: ["tenders"],
    message: "refund tenders must add up to the total",
  })
  .refine((r) => r.lines.reduce((a, l) => a + l.refundMinor, 0) === r.totalMinor, {
    path: ["lines"],
    message: "refund lines must add up to the total",
  })
  .refine((r) => r.saleId === null || r.lines.every((l) => l.saleLine !== undefined), {
    path: ["lines"],
    message: "saleLine is required on a return with a receipt",
  })
  .refine((r) => r.saleId !== null || r.overrideId !== undefined, {
    path: ["overrideId"],
    message: "a no-receipt return needs an override",
  });
export type CompleteReturn = z.output<typeof CompleteReturnSchema>;
