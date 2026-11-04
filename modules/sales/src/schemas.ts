import { z } from "@hono/zod-openapi";

import { ZReport } from "./events.ts";

const uuid7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "UUIDv7");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const int = z.number().int();
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
/** `<business_date>|<id>`: keyset position of the last row of the previous page (newest first). */
const after = z.string().regex(/^\d{4}-\d{2}-\d{2}\|[0-9a-f-]{36}$/);
const limit = z.coerce.number().int().min(1).max(200);

export const SalesQuerySchema = z.object({
  branchId: uuid7.optional(),
  shiftId: uuid7.optional(),
  customerId: uuid7.optional(),
  status: z.enum(["completed", "voided"]).optional(),
  from: date.optional(),
  to: date.optional(),
  /** Only sales with review flags (price_mismatch, stale_price, ...). */
  flagged: bool.optional(),
  flag: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
  include: z
    .string()
    .regex(/^[a-z,]{0,60}$/)
    .optional(),
  after: after.optional(),
  limit: limit.optional(),
});

export const SaleSchema = z
  .object({
    id: uuid7,
    branchId: uuid7,
    terminalId: uuid7,
    shiftId: uuid7,
    operatorId: uuid7,
    customerId: uuid7.nullable(),
    saleNo: int,
    invoiceNo: z.string().nullable(),
    status: z.enum(["completed", "voided"]),
    currency: z.string(),
    subtotalMinor: int,
    discountMinor: int,
    feeMinor: int,
    taxMinor: int,
    totalMinor: int,
    cashRoundingMinor: int,
    payableMinor: int,
    businessDate: date,
    flags: z.array(z.string()),
    completedAt: z.string(),
    lines: z
      .array(
        z.object({
          line: int,
          variantId: uuid7,
          name: z.string(),
          sku: z.string(),
          locationId: uuid7,
          batchId: uuid7.nullable(),
          qty: z.string(),
          unitPriceMinor: int,
          priceSource: z.enum(["override", "batch", "list"]),
          discountMinor: int,
          taxMinor: int,
          totalMinor: int,
          unitCostMinor: int.nullable(),
        }),
      )
      .optional(),
    tenders: z
      .array(
        z.object({
          id: uuid7,
          kind: z.string(),
          amountMinor: int,
          receivedMinor: int.nullable(),
          changeMinor: int.nullable(),
          card: z
            .object({
              provider: z.string().nullable(),
              providerRef: z.string().nullable(),
              authCode: z.string().nullable(),
              last4: z.string().nullable(),
              brand: z.string().nullable(),
            })
            .nullable(),
        }),
      )
      .optional(),
    returns: z
      .array(
        z.object({
          id: uuid7,
          returnNo: int,
          totalMinor: int,
          reason: z.string(),
          flags: z.array(z.string()),
          occurredAt: z.string(),
          lines: z.array(
            z.object({
              line: int,
              saleLine: int.nullable(),
              qty: z.string(),
              refundMinor: int,
              disposition: z.enum(["restock", "writeoff"]),
            }),
          ),
        }),
      )
      .optional(),
    void: z
      .object({
        id: uuid7,
        reason: z.string(),
        operatorId: uuid7,
        overrideId: uuid7.nullable(),
        occurredAt: z.string(),
      })
      .nullable()
      .optional(),
  })
  .openapi("Sale");

export const SalePageSchema = z
  .object({ items: z.array(SaleSchema), nextCursor: z.string().nullable() })
  .openapi("SalePage");

export const ShiftsQuerySchema = z.object({
  branchId: uuid7.optional(),
  terminalId: uuid7.optional(),
  status: z.enum(["open", "closed"]).optional(),
  from: date.optional(),
  to: date.optional(),
  after: after.optional(),
  limit: limit.optional(),
});

export const ShiftSchema = z
  .object({
    id: uuid7,
    branchId: uuid7,
    terminalId: uuid7,
    openedBy: uuid7,
    closedBy: uuid7.nullable(),
    businessDate: date,
    currency: z.string(),
    status: z.enum(["open", "closed"]),
    openingFloatMinor: int,
    expectedCashMinor: int.nullable(),
    countedCashMinor: int.nullable(),
    overShortMinor: int.nullable(),
    blindCount: z.boolean().nullable(),
    flags: z.array(z.string()),
    openedAt: z.string(),
    closedAt: z.string().nullable(),
    /** Frozen at close; null while the shift is open. */
    zReport: ZReport.nullable(),
  })
  .openapi("Shift");

export const ShiftPageSchema = z
  .object({ items: z.array(ShiftSchema), nextCursor: z.string().nullable() })
  .openapi("ShiftPage");

export const IdParam = z.object({ id: uuid7 });
export { uuid7 };
