import { z } from "zod";

import type { ReceiptDoc } from "@wise-biz/receipt";

const int = z.number().int();
const decimal = z.string().regex(/^\d+(\.\d+)?$/);

/**
 * Tolerant reader of `sales.sale.completed@v1` (consumer-driven: no import of the sales module). Only the fields the
 * receipt needs, each strictly typed. Every other field the producer sends (customer, operator, terminal...) is
 * ignored, so sales can add fields without breaking this module. A missing or mistyped field throws (retry, then DLQ).
 */
export const SaleCompletedEnvelope = z.object({
  tenantId: z.uuidv7(),
  data: z.object({
    saleId: z.uuidv7(),
    saleNo: int,
    invoiceNo: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    completedAt: z.iso.datetime({ offset: true }),
    subtotalMinor: int,
    discountMinor: int,
    feeMinor: int,
    taxMinor: int,
    cashRoundingMinor: int,
    payableMinor: int,
    lines: z.array(
      z.object({
        sku: z.string(),
        qty: decimal,
        unitPriceMinor: int,
        discountMinor: int,
        totalMinor: int,
      }),
    ),
    tenders: z.array(z.object({ kind: z.string(), amountMinor: int })),
  }),
});

export type SaleCompletedData = z.output<typeof SaleCompletedEnvelope>["data"];

/** The public document stored in receipt_links.snapshot. Also the shape the public lookup parses back. */
export const ReceiptSnapshot = z.object({
  saleNo: int,
  invoiceNo: z.string(),
  currency: z.string(),
  completedAt: z.string(),
  lines: z.array(
    z.object({
      sku: z.string(),
      qty: z.string(),
      unitPriceMinor: int,
      discountMinor: int,
      totalMinor: int,
    }),
  ),
  subtotalMinor: int,
  discountMinor: int,
  feeMinor: int,
  taxMinor: int,
  cashRoundingMinor: int,
  payableMinor: int,
  tenders: z.array(z.object({ kind: z.string(), amountMinor: int })),
});

export type ReceiptSnapshot = z.output<typeof ReceiptSnapshot>;

/** Pure: the public fields of a completed sale. No ids beyond the invoice number leave the event. */
export function snapshotOf(d: SaleCompletedData): ReceiptSnapshot {
  return {
    saleNo: d.saleNo,
    invoiceNo: d.invoiceNo,
    currency: d.currency,
    completedAt: d.completedAt,
    lines: d.lines.map((l) => ({
      sku: l.sku,
      qty: l.qty,
      unitPriceMinor: l.unitPriceMinor,
      discountMinor: l.discountMinor,
      totalMinor: l.totalMinor,
    })),
    subtotalMinor: d.subtotalMinor,
    discountMinor: d.discountMinor,
    feeMinor: d.feeMinor,
    taxMinor: d.taxMinor,
    cashRoundingMinor: d.cashRoundingMinor,
    payableMinor: d.payableMinor,
    tenders: d.tenders.map((t) => ({ kind: t.kind, amountMinor: t.amountMinor })),
  };
}

const TENDER_LABEL: ReadonlyMap<string, string> = new Map([
  ["cash", "Cash"],
  ["card", "Card"],
]);

/** Pure: the snapshot as the shared receipt renderer reads it. Lines are named by SKU (no catalog read here). */
export function toReceiptDoc(s: ReceiptSnapshot): ReceiptDoc {
  return {
    currency: s.currency,
    locale: "en-US",
    number: s.invoiceNo,
    at: s.completedAt,
    store: { name: "Receipt" },
    lines: s.lines.map((l) => ({
      name: l.sku,
      qty: l.qty,
      unitMinor: l.unitPriceMinor,
      totalMinor: l.totalMinor,
      discountMinor: l.discountMinor,
    })),
    subtotalMinor: s.subtotalMinor,
    discountMinor: s.discountMinor,
    taxes: s.taxMinor > 0 ? [{ name: "Tax", amountMinor: s.taxMinor }] : [],
    feeMinor: s.feeMinor,
    roundingMinor: s.cashRoundingMinor,
    totalMinor: s.payableMinor,
    tenders: s.tenders.map((t) => ({
      label: TENDER_LABEL.get(t.kind.toLowerCase()) ?? "Other",
      amountMinor: t.amountMinor,
    })),
    changeMinor: 0,
  };
}
