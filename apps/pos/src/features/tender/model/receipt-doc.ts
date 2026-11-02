import type { CommittedSale } from "./commit.ts";
import type { TenderEntry } from "./tender.ts";
import type { CartLine } from "../../../state/slices.ts";
import type { CartPricing } from "../../sell/model/view.ts";
import type { ReceiptDoc } from "@wise-biz/receipt";

export interface StoreInfo {
  readonly name: string;
  readonly address?: readonly string[];
  readonly taxIds?: readonly string[];
  readonly header?: readonly string[];
  readonly footer?: readonly string[];
}

const LABEL: Record<TenderEntry["kind"], string> = {
  cash: "Cash",
  card: "Card",
  voucher: "Voucher",
  store_credit: "Store credit",
};

/** The receipt of a committed sale, from the same numbers that were signed into the command. */
export function buildReceiptDoc(o: {
  readonly sale: CommittedSale;
  readonly pricing: CartPricing;
  readonly cart: readonly CartLine[];
  readonly tenders: readonly TenderEntry[];
  readonly store: StoreInfo;
  readonly locale: string;
  readonly operatorName?: string;
  readonly note?: string | null;
  readonly shortUrl?: string;
}): ReceiptDoc {
  const priced = o.pricing.priced;
  if (priced === undefined) throw new Error("cannot print an unpriced sale");
  const byId = new Map(o.cart.map((l) => [l.id, l]));
  const change = o.tenders.reduce((n, t) => n + (t.changeMinor ?? 0), 0);
  return {
    currency: priced.currency,
    locale: o.locale,
    number: `Receipt ${String(o.sale.saleNo).padStart(6, "0")}`,
    at: new Date(o.sale.completedAt).toISOString(),
    ...(o.operatorName === undefined ? {} : { operator: o.operatorName }),
    store: {
      name: o.store.name,
      ...(o.store.address === undefined ? {} : { address: o.store.address }),
      ...(o.store.taxIds === undefined ? {} : { taxIds: o.store.taxIds }),
    },
    ...(o.store.header === undefined ? {} : { header: o.store.header }),
    lines: priced.lines.map((p) => {
      const l = byId.get(p.id);
      const discount = [...p.lineDiscounts, ...p.cartDiscounts].reduce(
        (s, d) => s + d.amountMinor,
        0,
      );
      return {
        name: l?.name ?? p.variantId,
        qty: p.qty,
        unitMinor: p.unitPriceMinor,
        totalMinor: p.totalMinor,
        ...(discount > 0 ? { discountMinor: discount } : {}),
        ...(l?.note === undefined || l.note === "" ? {} : { note: l.note }),
      };
    }),
    subtotalMinor: priced.subtotalMinor,
    discountMinor: priced.discountMinor,
    taxes: priced.taxes.map((t) => ({ name: t.name, amountMinor: t.amountMinor })),
    ...(priced.feeMinor > 0 ? { feeMinor: priced.feeMinor } : {}),
    ...(priced.cashRoundingMinor === 0 ? {} : { roundingMinor: priced.cashRoundingMinor }),
    totalMinor: priced.payableMinor,
    tenders: o.tenders.map((t) => ({
      label: t.card?.last4 === undefined ? LABEL[t.kind] : `${LABEL[t.kind]} ****${t.card.last4}`,
      amountMinor: t.receivedMinor ?? t.amountMinor,
    })),
    changeMinor: change,
    ...(o.note === null || o.note === undefined ? {} : { note: o.note }),
    ...(o.store.footer === undefined ? {} : { footer: o.store.footer }),
    ...(o.shortUrl === undefined ? {} : { qrUrl: o.shortUrl }),
    openDrawer: o.tenders.some((t) => t.kind === "cash"),
  };
}
