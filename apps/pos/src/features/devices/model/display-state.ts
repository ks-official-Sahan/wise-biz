import type { DisplayState } from "../../../runtime/desktop.ts";
import type { SellLine, SellTotals } from "../../sell/ui/types.ts";
import type { TenderState } from "../../tender/model/session.ts";

/**
 * What the customer-facing screen shows for the cart and the payment state: the cart with its total while the sale is
 * rung up, the change and a thank-you once it is paid, and the welcome screen (null) for an empty cart.
 */
export function displayStateFor(o: {
  lines: readonly SellLine[];
  totals: SellTotals;
  tender?: TenderState | undefined;
}): DisplayState | null {
  const done = o.tender?.phase === "done";
  if (o.lines.length === 0 && !done) return null;
  return {
    lines: o.lines.map((l) => ({
      name: l.name.slice(0, 120),
      qty: String(l.qty).slice(0, 16),
      totalMinor: Math.max(0, Math.round(l.lineTotalMinor)),
    })),
    totalMinor: Math.max(0, Math.round(o.totals.totalMinor)),
    changeMinor: done ? Math.max(0, o.tender?.changeMinor ?? 0) : 0,
    currency: o.totals.currency,
    ...(done ? { message: "Thank you" } : {}),
  };
}
