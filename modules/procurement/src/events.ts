import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/** One topic keyed by tenant: a PO's send, receipts and close reach consumers in order. */
export const PROCUREMENT_TOPIC = "procurement";

const qty = z.string();
const minor = z.number().int().min(0);

const priceFact = z.object({
  variantId: z.string(),
  unitCostMinor: minor,
  currency: z.string(),
  minOrderQty: qty,
  validFrom: z.string(),
});

/** Supplier record changed (create, edit, archive) or its price list was upserted (`prices` then lists what changed). */
export const SupplierUpsertedV1 = defineEvent(
  "procurement.supplier.upserted",
  1,
  z.object({
    supplierId: z.string(),
    name: z.string(),
    currency: z.string(),
    paymentTermsDays: z.number().int(),
    leadTimeDays: z.number().int(),
    archived: z.boolean(),
    prices: z.array(priceFact),
  }),
);

/** The PO left draft: the supplier now expects these lines at these costs. */
export const PurchaseOrderSentV1 = defineEvent(
  "procurement.po.sent",
  1,
  z.object({
    purchaseOrderId: z.string(),
    poNo: z.number().int(),
    supplierId: z.string(),
    branchId: z.string(),
    locationId: z.string(),
    currency: z.string(),
    totalMinor: minor,
    expectedOn: z.string().nullable(),
    lines: z.array(
      z.object({
        line: z.number().int(),
        variantId: z.string(),
        orderedQty: qty,
        unitCostMinor: minor,
        lineTotalMinor: minor,
      }),
    ),
  }),
);

/** One event per receipt. `receivedQty` is the PO line's total after this receipt. */
export const PurchaseOrderReceivedV1 = defineEvent(
  "procurement.po.received",
  1,
  z.object({
    purchaseOrderId: z.string(),
    poNo: z.number().int(),
    receiptId: z.string(),
    reference: z.string(),
    locationId: z.string(),
    status: z.enum(["partially_received", "received"]),
    receivedAt: z.string(),
    lines: z.array(
      z.object({
        line: z.number().int(),
        variantId: z.string(),
        qty: qty,
        unitCostMinor: minor,
        orderedQty: qty,
        receivedQty: qty,
      }),
    ),
  }),
);

/** Closed with variance: `shortQty` is what was ordered and never came (zero on a complete PO). */
export const PurchaseOrderClosedV1 = defineEvent(
  "procurement.po.closed",
  1,
  z.object({
    purchaseOrderId: z.string(),
    poNo: z.number().int(),
    supplierId: z.string(),
    locationId: z.string(),
    totalMinor: minor,
    lines: z.array(
      z.object({
        line: z.number().int(),
        variantId: z.string(),
        orderedQty: qty,
        receivedQty: qty,
        shortQty: qty,
      }),
    ),
  }),
);

export const PROCUREMENT_EVENTS = [
  SupplierUpsertedV1,
  PurchaseOrderSentV1,
  PurchaseOrderReceivedV1,
  PurchaseOrderClosedV1,
] as const;
