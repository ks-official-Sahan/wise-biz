import { ENGINE_VERSION } from "@wise-biz/pricing-engine";

import type { TenderEntry } from "./tender.ts";
import type { Approval, CartLine } from "../../../state/slices.ts";
import type { PricingContext } from "../../sell/model/context.ts";
import type { PricedCart } from "@wise-biz/pricing-engine";

export interface SaleFacts {
  readonly saleId: string;
  readonly saleNo: number;
  readonly shiftId: string;
  readonly operatorId: string;
  readonly customerId: string | null;
  readonly completedAt: number;
  readonly businessDate: string;
  /** Where each variant is sold from on this terminal (stock location of the branch). */
  readonly locationOf: (variantId: string) => string;
  readonly newId: () => string;
}

/** Local calendar date of the terminal: the business day a sale belongs to (shift close compares against it). */
export function businessDateOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The `complete_sale` command body (contracts: CompleteSaleSchema) from what priced the cart on the device. Names, SKUs
 * and unit prices are snapshots, so reports never re-join current catalog data. `meta` is added by the outbox.
 */
export function buildCompleteSale(
  priced: PricedCart,
  cart: readonly CartLine[],
  ctx: PricingContext,
  tenders: readonly TenderEntry[],
  f: SaleFacts,
): Record<string, unknown> {
  const byId = new Map(cart.map((l) => [l.id, l]));
  const lines = priced.lines.map((p) => {
    const l = byId.get(p.id);
    const discountMinor = [...p.lineDiscounts, ...p.cartDiscounts].reduce(
      (s, d) => s + d.amountMinor,
      0,
    );
    return {
      variantId: p.variantId,
      name: l?.name ?? p.variantId,
      sku: l?.sku ?? p.variantId,
      locationId: f.locationOf(p.variantId),
      qty: p.qty,
      unitPriceMinor: p.unitPriceMinor,
      priceSource: p.priceSource,
      discountMinor,
      taxMinor: p.taxMinor,
      totalMinor: p.totalMinor,
      ...(l?.note === undefined || l.note === "" ? {} : { detail: { note: l.note } }),
    };
  });
  const promotionIds = [
    ...new Set(
      priced.lines.flatMap((p) =>
        [...p.lineDiscounts, ...p.cartDiscounts].map((d) => d.promotionId),
      ),
    ),
  ];
  return {
    id: f.saleId,
    shiftId: f.shiftId,
    operatorId: f.operatorId,
    ...(f.customerId === null ? {} : { customerId: f.customerId }),
    saleNo: f.saleNo,
    currency: priced.currency,
    businessDate: f.businessDate,
    completedAt: new Date(f.completedAt).toISOString(),
    priceListId: ctx.priceListId,
    priceListVersion: ctx.priceListVersion,
    engineVersion: ENGINE_VERSION,
    policyVersion: 0,
    promotionIds,
    lines,
    tenders: tenders.map((t) => ({
      id: t.id,
      kind: t.kind,
      amountMinor: t.amountMinor,
      ...(t.receivedMinor === undefined ? {} : { receivedMinor: t.receivedMinor }),
      ...(t.changeMinor === undefined ? {} : { changeMinor: t.changeMinor }),
      ...(t.card === undefined ? {} : { card: t.card }),
    })),
    subtotalMinor: priced.subtotalMinor,
    discountMinor: priced.discountMinor,
    feeMinor: priced.feeMinor,
    taxMinor: priced.taxMinor,
    totalMinor: priced.totalMinor,
    cashRoundingMinor: priced.cashRoundingMinor,
    payableMinor: priced.payableMinor,
  };
}

/** `record_override` bodies for the approvals kept with the cart; they go into the chain before the sale. */
export function overrideCommands(
  approvals: readonly Approval[],
  saleId: string,
): Record<string, unknown>[] {
  return approvals.map((a) => ({
    id: a.id,
    requesterId: a.requesterId,
    approverId: a.approverId,
    permission: a.permission,
    reason: a.reason,
    subjectType: "sale",
    subjectId: saleId,
    occurredAt: new Date(a.at).toISOString(),
  }));
}
