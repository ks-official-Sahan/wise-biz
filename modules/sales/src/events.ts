import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

/** events.md: keyed tenantId:branchId, so a branch's documents stay in order for reporting and metering. */
export const SALES_TOPIC = "sales";

const qty = z.string();
const int = z.number().int();

/**
 * Fat event (events.md rule 4): consumers get every line without calling back. Line names and `detail` stay out, so
 * a 500-line sale fits the 256 KiB outbox payload (names: catalog projection by variantId, or the sale detail API).
 */
export const SaleCompletedV1 = defineEvent(
  "sales.sale.completed",
  1,
  z.object({
    saleId: z.string(),
    branchId: z.string(),
    terminalId: z.string(),
    shiftId: z.string(),
    operatorId: z.string(),
    customerId: z.string().nullable(),
    saleNo: int,
    invoiceNo: z.string(),
    currency: z.string(),
    businessDate: z.string(),
    completedAt: z.string(),
    subtotalMinor: int,
    discountMinor: int,
    feeMinor: int,
    taxMinor: int,
    totalMinor: int,
    cashRoundingMinor: int,
    payableMinor: int,
    promotionIds: z.array(z.string()),
    coupons: z.array(z.string()),
    flags: z.array(z.string()),
    lines: z.array(
      z.object({
        line: int,
        variantId: z.string(),
        sku: z.string(),
        locationId: z.string(),
        batchId: z.string().nullable(),
        qty,
        unitPriceMinor: int,
        discountMinor: int,
        taxMinor: int,
        totalMinor: int,
        unitCostMinor: int.nullable(),
      }),
    ),
    tenders: z.array(z.object({ kind: z.string(), amountMinor: int })),
  }),
);

export const ShiftOpenedV1 = defineEvent(
  "sales.shift.opened",
  1,
  z.object({
    shiftId: z.string(),
    branchId: z.string(),
    terminalId: z.string(),
    operatorId: z.string(),
    businessDate: z.string(),
    currency: z.string(),
    openingFloatMinor: int,
    openedAt: z.string(),
  }),
);

const stockLine = z.object({
  variantId: z.string(),
  locationId: z.string(),
  batchId: z.string().nullable(),
  qty,
});

/** The sale's status is now voided; its stock movements were reversed in the same transaction. */
export const SaleVoidedV1 = defineEvent(
  "sales.sale.voided",
  1,
  z.object({
    saleId: z.string(),
    voidId: z.string(),
    invoiceNo: z.string(),
    operatorId: z.string(),
    overrideId: z.string().nullable(),
    reason: z.string(),
    payableMinor: int,
    currency: z.string(),
    occurredAt: z.string(),
    flags: z.array(z.string()),
    stock: z.array(stockLine),
  }),
);

export const ReturnCompletedV1 = defineEvent(
  "sales.return.completed",
  1,
  z.object({
    returnId: z.string(),
    saleId: z.string().nullable(),
    shiftId: z.string(),
    operatorId: z.string(),
    returnNo: int,
    currency: z.string(),
    totalMinor: int,
    businessDate: z.string(),
    occurredAt: z.string(),
    overrideId: z.string().nullable(),
    flags: z.array(z.string()),
    lines: z.array(
      z.object({
        line: int,
        saleLine: int.nullable(),
        variantId: z.string(),
        sku: z.string(),
        locationId: z.string(),
        batchId: z.string().nullable(),
        qty,
        refundMinor: int,
        taxMinor: int,
        disposition: z.enum(["restock", "writeoff"]),
      }),
    ),
    tenders: z.array(z.object({ kind: z.string(), amountMinor: int })),
  }),
);

/** Z-report: the shift's totals frozen at close (reporting reads it, never re-derives a closed shift). */
export const ZReport = z.object({
  sales: z.object({ count: int, payableMinor: int, taxMinor: int, discountMinor: int }),
  voids: z.object({ count: int, payableMinor: int }),
  returns: z.object({ count: int, totalMinor: int }),
  tenders: z.array(z.object({ kind: z.string(), salesMinor: int, refundsMinor: int })),
  cash: z.object({
    openingFloatMinor: int,
    salesMinor: int,
    refundsMinor: int,
    voidedMinor: int,
    payInMinor: int,
    payOutMinor: int,
    floatAddMinor: int,
    dropsMinor: int,
    expectedMinor: int,
    countedMinor: int,
    overShortMinor: int,
  }),
  drawerOpens: int,
});
export type ZReport = z.output<typeof ZReport>;

export const ShiftClosedV1 = defineEvent(
  "sales.shift.closed",
  1,
  z.object({
    shiftId: z.string(),
    branchId: z.string(),
    terminalId: z.string(),
    operatorId: z.string(),
    businessDate: z.string(),
    currency: z.string(),
    closedAt: z.string(),
    blindCount: z.boolean(),
    flags: z.array(z.string()),
    zReport: ZReport,
  }),
);

export const OverrideApprovedV1 = defineEvent(
  "sales.override.approved",
  1,
  z.object({
    overrideId: z.string(),
    terminalId: z.string(),
    requesterId: z.string(),
    approverId: z.string(),
    permission: z.string(),
    subjectType: z.string().nullable(),
    subjectId: z.string().nullable(),
    occurredAt: z.string(),
    flags: z.array(z.string()),
  }),
);

export const SALES_EVENTS = [
  SaleCompletedV1,
  ShiftOpenedV1,
  SaleVoidedV1,
  ReturnCompletedV1,
  ShiftClosedV1,
  OverrideApprovedV1,
] as const;
