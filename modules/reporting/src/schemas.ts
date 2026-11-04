import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "UUID");

/** A report range is in business dates (the branch's own day), inclusive, at most 366 days. */
export const RangeQuerySchema = z
  .object({ from: date, to: date, branchId: uuid.optional() })
  .refine((r) => r.from <= r.to, { path: ["to"], message: "must not be before from" })
  .refine((r) => days(r.from, r.to) <= 366, { path: ["to"], message: "at most 366 days" });

export const SalesQuerySchema = z
  .object({
    from: date,
    to: date,
    branchId: uuid.optional(),
    groupBy: z.enum(["day", "branch", "terminal"]).default("day"),
  })
  .refine((r) => r.from <= r.to, { path: ["to"], message: "must not be before from" })
  .refine((r) => days(r.from, r.to) <= 366, { path: ["to"], message: "at most 366 days" });

export const ProductsQuerySchema = z
  .object({
    from: date,
    to: date,
    branchId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((r) => r.from <= r.to, { path: ["to"], message: "must not be before from" })
  .refine((r) => days(r.from, r.to) <= 366, { path: ["to"], message: "at most 366 days" });

export const RebuildSchema = z
  .object({ from: date, to: date })
  .refine((r) => r.from <= r.to, { path: ["to"], message: "must not be before from" })
  .refine((r) => days(r.from, r.to) <= 92, {
    path: ["to"],
    message: "rebuild at most 92 days at a time",
  });

function days(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

const money = z.number().int();
export const SalesRowSchema = z.object({
  key: z.string(),
  currency: z.string(),
  salesCount: z.number().int(),
  subtotalMinor: money,
  discountMinor: money,
  feeMinor: money,
  taxMinor: money,
  payableMinor: money,
  voidsCount: z.number().int(),
  voidsPayableMinor: money,
  returnsCount: z.number().int(),
  returnsMinor: money,
  netMinor: money,
});
export const SalesReportSchema = z
  .object({ groupBy: z.enum(["day", "branch", "terminal"]), rows: z.array(SalesRowSchema) })
  .meta({ id: "SalesReport" });

export const ProductRowSchema = z.object({
  variantId: z.string(),
  sku: z.string(),
  currency: z.string(),
  qty: z.string(),
  revenueMinor: money,
  taxMinor: money,
  discountMinor: money,
  costMinor: money,
  netMinor: money,
  profitMinor: money,
  returnedQty: z.string(),
  refundMinor: money,
});
export const ProductsReportSchema = z
  .object({ rows: z.array(ProductRowSchema) })
  .meta({ id: "ProductsReport" });

export const HoursReportSchema = z
  .object({
    rows: z.array(
      z.object({
        hour: z.number().int().min(0).max(23),
        currency: z.string(),
        salesCount: z.number().int(),
        payableMinor: money,
      }),
    ),
  })
  .meta({ id: "HoursReport" });

export const OperatorsReportSchema = z
  .object({
    rows: z.array(
      z.object({
        operatorId: z.string(),
        currency: z.string(),
        salesCount: z.number().int(),
        payableMinor: money,
        averageMinor: money,
        discountMinor: money,
        voidsCount: z.number().int(),
        voidsPayableMinor: money,
      }),
    ),
  })
  .meta({ id: "OperatorsReport" });

export const PaymentsReportSchema = z
  .object({
    rows: z.array(
      z.object({
        kind: z.string(),
        currency: z.string(),
        count: z.number().int(),
        salesMinor: money,
        refundsMinor: money,
        netMinor: money,
      }),
    ),
  })
  .meta({ id: "PaymentsReport" });

export const TaxReportSchema = z
  .object({
    rows: z.array(
      z.object({
        day: z.string(),
        currency: z.string(),
        taxMinor: money,
        payableMinor: money,
        netOfTaxMinor: money,
      }),
    ),
  })
  .meta({ id: "TaxReport" });

export const RebuildResultSchema = z
  .object({ sales: z.number().int(), returns: z.number().int() })
  .meta({ id: "RebuildResult" });

export const CreateExportSchema = z
  .object({ kind: z.enum(["sales_lines"]), from: date, to: date, branchId: uuid.optional() })
  .refine((r) => r.from <= r.to, { path: ["to"], message: "must not be before from" })
  .refine((r) => days(r.from, r.to) <= 366, { path: ["to"], message: "at most 366 days" });

export const ExportSchema = z
  .object({
    id: z.string(),
    kind: z.string(),
    status: z.enum(["queued", "running", "ready", "failed", "expired"]),
    from: z.string(),
    to: z.string(),
    rowCount: z.number().int().nullable(),
    error: z.string().nullable(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    expiresAt: z.string(),
    downloadable: z.boolean(),
  })
  .meta({ id: "ReportExport" });

export const ExportListSchema = z
  .object({ exports: z.array(ExportSchema) })
  .meta({ id: "ReportExportList" });
