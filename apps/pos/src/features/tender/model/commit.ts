import { ensureShift } from "../../shift/model/shift.ts";

import { buildCompleteSale, businessDateOf, overrideCommands } from "./sale-command.ts";

import type { TenderEntry } from "./tender.ts";
import type { Approval, CartLine } from "../../../state/slices.ts";
import type { PricingContext } from "../../sell/model/context.ts";
import type { CartPricing } from "../../sell/model/view.ts";
import type { OutboxTx, Queryable } from "@wise-biz/sync";

const SALE_NO_KEY = "pos.sale_no";

export interface CommitDeps {
  /** `client.transaction`: domain rows and signed commands commit together or not at all. */
  readonly transaction: <T>(fn: (tx: OutboxTx) => Promise<T>) => Promise<T>;
  readonly ctx: PricingContext;
  readonly now: () => number;
  readonly newId: () => string;
  readonly locationOf: (variantId: string) => string;
  readonly operatorId: string;
}

export interface CommitInput {
  readonly pricing: CartPricing;
  readonly cart: readonly CartLine[];
  readonly tenders: readonly TenderEntry[];
  readonly customerId: string | null;
  readonly approvals: readonly Approval[];
  /** Fixed by the tender session, so a retry after a failed save writes the same sale and a card charge can be tied to it. */
  readonly saleId?: string;
}

export interface CommittedSale {
  readonly saleId: string;
  readonly saleNo: number;
  readonly completedAt: number;
  readonly shiftId: string;
}

export class SaleCommitError extends Error {
  override readonly name = "SaleCommitError";
  readonly code: "no_price" | "unbalanced" | "no_location";
  constructor(code: SaleCommitError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Completes a sale locally in ONE transaction: the next sale number, the shift (opened on the first sale of the day when
 * none is open; the shift screen arrives in P1-11), one stock decrement per line, any supervisor approvals, and the
 * signed `complete_sale` command. Either everything is written or nothing is, and the sale then reaches the server on
 * its own when there is a connection. No network on this path.
 */
export async function commitSale(deps: CommitDeps, input: CommitInput): Promise<CommittedSale> {
  const { priced } = input.pricing;
  if (priced === undefined) throw new SaleCommitError("no_price", "The cart has no price yet.");
  const tendered = input.tenders.reduce((n, t) => n + t.amountMinor, 0);
  if (tendered !== priced.payableMinor) {
    throw new SaleCommitError("unbalanced", "Payments do not add up to the amount due.");
  }
  const completedAt = deps.now();
  const saleId = input.saleId ?? deps.newId();

  return deps.transaction(async (tx) => {
    const sn = await tx.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", [SALE_NO_KEY]);
    const saleNo = (sn === undefined ? 0 : Number(sn.value)) + 1;
    await tx.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [SALE_NO_KEY, String(saleNo)],
    );

    const businessDate = businessDateOf(completedAt);
    const shift = await ensureShift(tx, deps, {
      completedAt,
      businessDate,
      currency: priced.currency,
    });

    for (const p of priced.lines) {
      await tx.run(
        "INSERT INTO local_movements (id, variant_id, location_id, batch_id, qty, ref_id, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        [deps.newId(), p.variantId, deps.locationOf(p.variantId), `-${p.qty}`, saleId, completedAt],
      );
    }

    for (const o of overrideCommands(input.approvals, saleId))
      await tx.enqueue("record_override", o);

    const command = buildCompleteSale(priced, input.cart, deps.ctx, input.tenders, {
      saleId,
      saleNo,
      shiftId: shift.id,
      operatorId: deps.operatorId,
      customerId: input.customerId,
      completedAt,
      businessDate,
      locationOf: deps.locationOf,
      newId: deps.newId,
    });
    await tx.enqueue("complete_sale", command);
    await tx.run(
      "INSERT INTO local_sales (id, shift_id, sale_no, completed_at, body) VALUES (?, ?, ?, ?, ?)",
      [
        saleId,
        shift.id,
        saleNo,
        completedAt,
        JSON.stringify({
          currency: priced.currency,
          payableMinor: priced.payableMinor,
          lines: command.lines,
          tenders: command.tenders,
        }),
      ],
    );
    return { saleId, saleNo, completedAt, shiftId: shift.id };
  });
}

/**
 * Stock location per variant from the synced branch balances. A variant with no balance row sells from the branch's
 * main location (the one holding the most rows). Undefined when the branch has no stock data yet: a sale cannot name a
 * location, so the tender sheet says so instead of guessing.
 */
export async function loadLocations(db: Queryable): Promise<{
  readonly locationOf: (variantId: string) => string;
  readonly ready: boolean;
}> {
  const rows = await db.all<{ payload: string }>(
    "SELECT payload FROM entities WHERE dataset = 'stock_branch' AND entity = 'stock'",
  );
  const byVariant = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const p = JSON.parse(r.payload) as { variantId?: string; locationId?: string };
    if (typeof p.variantId !== "string" || typeof p.locationId !== "string") continue;
    if (!byVariant.has(p.variantId)) byVariant.set(p.variantId, p.locationId);
    counts.set(p.locationId, (counts.get(p.locationId) ?? 0) + 1);
  }
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return {
    ready: main !== undefined,
    locationOf: (variantId) => {
      const loc = byVariant.get(variantId) ?? main;
      if (loc === undefined)
        throw new SaleCommitError("no_location", "This branch has no stock location yet.");
      return loc;
    },
  };
}
