import { isCurrency } from "@wise-biz/money";
import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = z.string().regex(UUID_RE, "UUID");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const date = z
  .string()
  .regex(DATE_RE, "YYYY-MM-DD")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "not a date");
const currency = z.string().refine(isCurrency, "ISO 4217 currency code");
/** Positive quantity with up to 4 places, at most 9 whole digits: its ten-thousandths stay a safe integer. */
const posQty = z
  .string()
  .regex(/^(?!0+(\.0+)?$)\d{1,9}(\.\d{1,4})?$/, "positive quantity, 4 places max");
const minorAmount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const version = z.number().int().min(1);
const page = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  after: z.string().max(64).optional(),
};

// --- Suppliers ---

const SupplierFields = z.object({
  name: z.string().trim().min(1).max(120),
  contactName: z.string().max(120).default(""),
  email: z.string().max(254).default(""),
  phone: z.string().max(40).default(""),
  address: z.string().max(500).default(""),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  leadTimeDays: z.number().int().min(0).max(365).default(0),
  currency,
});

export const CreateSupplierSchema = SupplierFields.meta({ id: "CreateSupplier" });
export const UpdateSupplierSchema = SupplierFields.extend({ version }).meta({
  id: "UpdateSupplier",
});
export const VersionSchema = z.object({ version }).meta({ id: "ExpectedVersion" });

export const SupplierListQuery = z.object({
  ...page,
  includeArchived: z.stringbool().default(false),
});

export const PriceItemSchema = z.object({
  variantId: uuid,
  unitCostMinor: minorAmount,
  currency,
  minOrderQty: posQty,
  validFrom: date,
});

export const UpsertPricesSchema = z
  .object({ items: z.array(PriceItemSchema).min(1).max(500) })
  .refine(
    (b) => new Set(b.items.map((i) => `${i.variantId}|${i.validFrom}`)).size === b.items.length,
    { message: "One price per variant and valid-from date.", path: ["items"] },
  )
  .meta({ id: "UpsertSupplierPrices" });

export const PriceListQuery = z.object(page);

// --- Purchase orders ---

const LineInput = z.object({ variantId: uuid, orderedQty: posQty, unitCostMinor: minorAmount });
const lines = z
  .array(LineInput)
  .min(1)
  .max(500)
  .refine((ls) => new Set(ls.map((l) => l.variantId)).size === ls.length, {
    message: "A variant can appear on one line only.",
  });

export const CreatePoSchema = z
  .object({
    supplierId: uuid,
    branchId: uuid,
    locationId: uuid,
    expectedOn: date.nullable().default(null),
    notes: z.string().max(2000).default(""),
    lines,
  })
  .meta({ id: "CreatePurchaseOrder" });

export const UpdatePoSchema = z
  .object({
    version,
    expectedOn: date.nullable().default(null),
    notes: z.string().max(2000).default(""),
    lines,
  })
  .meta({ id: "UpdatePurchaseOrder" });

export const ReceiveSchema = z
  .object({
    reference: z.string().max(80).default(""),
    lines: z
      .array(z.object({ line: z.number().int().min(1), qty: posQty }))
      .min(1)
      .max(500)
      .refine((ls) => new Set(ls.map((l) => l.line)).size === ls.length, {
        message: "A PO line can appear once per receipt.",
      }),
  })
  .meta({ id: "ReceivePurchaseOrder" });

export const PoListQuery = z.object({
  ...page,
  status: z
    .enum(["draft", "sent", "partially_received", "received", "closed", "cancelled"])
    .optional(),
});

// --- Transfers ---

/** Zero or more, 4 places max: a received quantity may be zero (nothing arrived). */
const qtyAny = z.string().regex(/^\d{1,9}(\.\d{1,4})?$/, "quantity, 4 places max");

const TransferLineInput = z.object({ variantId: uuid, requestedQty: posQty });
export const CreateTransferSchema = z
  .object({
    fromLocationId: uuid,
    toLocationId: uuid,
    notes: z.string().max(2000).default(""),
    lines: z
      .array(TransferLineInput)
      .min(1)
      .max(500)
      .refine((ls) => new Set(ls.map((l) => l.variantId)).size === ls.length, {
        message: "A variant can appear on one line only.",
      }),
  })
  .refine((b) => b.fromLocationId !== b.toLocationId, {
    message: "The destination must differ from the source.",
    path: ["toLocationId"],
  })
  .meta({ id: "CreateTransfer" });

/** Every line once: the service checks that together they cover the whole transfer. */
const oncePerLine = (ls: readonly { line: number }[]) =>
  new Set(ls.map((l) => l.line)).size === ls.length;
const lineMsg = { message: "A transfer line can appear once." };

export const DispatchTransferSchema = z
  .object({
    version,
    lines: z
      .array(z.object({ line: z.number().int().min(1), qty: posQty }))
      .min(1)
      .max(500)
      .refine(oncePerLine, lineMsg),
  })
  .meta({ id: "DispatchTransfer" });

export const ReceiveTransferSchema = z
  .object({
    version,
    lines: z
      .array(z.object({ line: z.number().int().min(1), receivedQty: qtyAny }))
      .min(1)
      .max(500)
      .refine(oncePerLine, lineMsg),
  })
  .meta({ id: "ReceiveTransfer" });

export const TransferListQuery = z.object({
  ...page,
  status: z.enum(["requested", "dispatched", "received", "closed", "cancelled"]).optional(),
});

export const IdParam = z.object({ id: uuid });

// --- Responses ---

export const SupplierSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    contactName: z.string(),
    email: z.string(),
    phone: z.string(),
    address: z.string(),
    paymentTermsDays: z.number().int(),
    leadTimeDays: z.number().int(),
    currency: z.string(),
    archivedAt: z.string().nullable(),
    version: z.number().int(),
    updatedAt: z.string(),
  })
  .meta({ id: "Supplier" });

export const SupplierPageSchema = z
  .object({ items: z.array(SupplierSchema), nextCursor: z.string().nullable() })
  .meta({ id: "SupplierPage" });

export const PriceSchema = z
  .object({
    id: z.string(),
    variantId: z.string(),
    unitCostMinor: z.number().int(),
    currency: z.string(),
    minOrderQty: z.string(),
    validFrom: z.string(),
  })
  .meta({ id: "SupplierPrice" });

export const PricePageSchema = z
  .object({ items: z.array(PriceSchema), nextCursor: z.string().nullable() })
  .meta({ id: "SupplierPricePage" });

export const PoLineSchema = z
  .object({
    line: z.number().int(),
    variantId: z.string(),
    orderedQty: z.string(),
    receivedQty: z.string(),
    shortQty: z.string(),
    unitCostMinor: z.number().int(),
    lineTotalMinor: z.number().int(),
  })
  .meta({ id: "PurchaseOrderLine" });

export const PoSchema = z
  .object({
    id: z.string(),
    poNo: z.number().int(),
    supplierId: z.string(),
    branchId: z.string(),
    locationId: z.string(),
    currency: z.string(),
    status: z.enum(["draft", "sent", "partially_received", "received", "closed", "cancelled"]),
    expectedOn: z.string().nullable(),
    notes: z.string(),
    totalMinor: z.number().int(),
    version: z.number().int(),
    sentAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lines: z.array(PoLineSchema),
  })
  .meta({ id: "PurchaseOrder" });

export const PoPageSchema = z
  .object({ items: z.array(PoSchema), nextCursor: z.string().nullable() })
  .meta({ id: "PurchaseOrderPage" });

export const ReceiptSchema = z
  .object({
    id: z.string(),
    reference: z.string(),
    receivedAt: z.string(),
    lines: z.array(
      z.object({
        line: z.number().int(),
        variantId: z.string(),
        qty: z.string(),
        unitCostMinor: z.number().int(),
      }),
    ),
  })
  .meta({ id: "PurchaseOrderReceipt" });

// --- Transfer responses ---

export const TransferLineSchema = z
  .object({
    line: z.number().int(),
    variantId: z.string(),
    requestedQty: z.string(),
    dispatchedQty: z.string(),
    receivedQty: z.string(),
    varianceQty: z.string(),
    valueMinor: z.number().int(),
  })
  .meta({ id: "TransferLine" });

export const TransferSchema = z
  .object({
    id: z.string(),
    transferNo: z.number().int(),
    fromLocationId: z.string(),
    toLocationId: z.string(),
    status: z.enum(["requested", "dispatched", "received", "closed", "cancelled"]),
    notes: z.string(),
    currency: z.string().nullable(),
    /** What is on the road now: the dispatched quantity and its value, both zero once received or closed. */
    inTransitQty: z.string(),
    inTransitValueMinor: z.number().int(),
    version: z.number().int(),
    dispatchedAt: z.string().nullable(),
    receivedAt: z.string().nullable(),
    closedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    lines: z.array(TransferLineSchema),
  })
  .meta({ id: "Transfer" });

export const TransferPageSchema = z
  .object({ items: z.array(TransferSchema), nextCursor: z.string().nullable() })
  .meta({ id: "TransferPage" });

export const ReceiveResultSchema = z
  .object({ receipt: ReceiptSchema, purchaseOrder: PoSchema })
  .meta({ id: "PurchaseOrderReceiveResult" });
