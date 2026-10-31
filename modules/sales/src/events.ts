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

export const SALES_EVENTS = [SaleCompletedV1, ShiftOpenedV1] as const;
