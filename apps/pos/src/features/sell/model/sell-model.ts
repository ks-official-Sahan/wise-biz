import { cartSlice } from "../../../state/slices.ts";

import { toQty4 } from "./qty.ts";
import { needsOverride, permissionsOf } from "./rules.ts";
import { resolveScan } from "./scan.ts";
import { createCartPricer } from "./view.ts";

import type { SellContext } from "./context.ts";
import type { Permissions } from "./rules.ts";
import type { CartPricing } from "./view.ts";
import type { Approval, CartLine } from "../../../state/slices.ts";
import type { PosStore } from "../../../state/store.ts";
import type { CustomRule } from "@wise-biz/barcode";
import type { Queryable } from "@wise-biz/sync";

/** A parked or crash-recovery cart older than this is dropped instead of resumed (prices and promotions moved on). */
export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
const DRAFT_DEBOUNCE_MS = 150;

export interface SellModelDeps {
  readonly store: PosStore;
  readonly db: Queryable;
  readonly ctx: SellContext;
  readonly indexes: {
    variantForBarcode: (code: string) => string | undefined;
    search: (
      text: string,
      limit?: number,
    ) => Promise<{ variantId: string; name: string; sku: string }[]>;
  };
  readonly newId: () => string;
  readonly now?: () => number;
  readonly locale?: string;
  readonly rules?: readonly CustomRule[];
  /** Local timings (scan_to_line_ms, add_to_totals_ms) for the dev overlay and the sampled metrics. */
  readonly onMetric?: (name: string, ms: number) => void;
  readonly onError?: (err: unknown) => void;
}

export type AddResult =
  | { readonly type: "added"; readonly lineId: string }
  | { readonly type: "unknown"; readonly code: string }
  | { readonly type: "no_price"; readonly name: string }
  | { readonly type: "not_ready" };

export type EditResult =
  | { readonly type: "done" }
  /** The operator needs a supervisor: show the override sheet, then call `approve` with the result. */
  | {
      readonly type: "needs_override";
      readonly lineId: string;
      readonly kind: "remove" | "reduce";
      readonly nextQty?: string;
    };

export interface ParkedSale {
  readonly id: string;
  readonly operatorId: string;
  readonly updatedAt: number;
  /** Units in the cart (a weighed line counts as one). */
  readonly itemCount: number;
}

interface DraftBody {
  readonly lines: CartLine[];
  readonly customerId: string | null;
  readonly note: string | null;
  readonly approvals: Approval[];
}

/**
 * The sell screen's brain, free of React: scan and search, add with merge, edit with the undo/override rule, pricing,
 * park and resume, crash-recovery drafts. Everything reads local data; nothing here waits on the network.
 */
export function createSellModel(deps: SellModelDeps) {
  const { store, db, ctx } = deps;
  const now = deps.now ?? Date.now;
  const metric = (n: string, ms: number) => deps.onMetric?.(n, ms);
  const price = createCartPricer(deps.locale ?? "en-US", now);
  const operatorId = (): string => store.getState().session.operator?.userId ?? "";
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const isDisposed = () => disposed;

  const permissions = (): Permissions =>
    permissionsOf(store.getState().session.operator?.permissions);

  async function addVariant(
    variantId: string,
    qty: string,
    extra: { priceOverrideMinor?: number } = {},
  ): Promise<AddResult> {
    if (ctx.current === undefined || disposed) return { type: "not_ready" };
    const v = await ctx.variant(variantId);
    if (v === undefined) return { type: "unknown", code: variantId };
    if (extra.priceOverrideMinor === undefined && (await ctx.price(variantId)) === undefined) {
      return { type: "no_price", name: v.name };
    }
    // The operator may have locked while the reads ran: the line must not land in the next operator's cart.
    if (isDisposed()) return { type: "not_ready" };
    const id = deps.newId();
    store.dispatch(
      cartSlice.actions.lineAdded({
        id,
        variantId,
        sku: v.sku,
        name: v.name,
        taxCategory: v.taxCategory,
        categoryIds: v.categoryIds,
        qty,
        addedAt: now(),
        ...(extra.priceOverrideMinor === undefined
          ? {}
          : { priceOverrideMinor: extra.priceOverrideMinor }),
      }),
    );
    scheduleDraft();
    return { type: "added", lineId: id };
  }

  function scheduleDraft(): void {
    if (disposed) return;
    if (draftTimer !== undefined) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      saveDraft().catch(() => undefined);
    }, DRAFT_DEBOUNCE_MS);
  }

  const body = (): DraftBody => {
    const c = store.getState().cart;
    return {
      lines: c.ids.flatMap((i) => {
        const l = c.entities[i];
        return l === undefined ? [] : [l];
      }),
      customerId: c.customerId,
      note: c.note,
      approvals: c.approvals,
    };
  };

  async function saveDraft(): Promise<void> {
    const op = operatorId();
    if (op === "") return;
    const b = body();
    const id = `current:${op}`;
    if (b.lines.length === 0) {
      await db.run("DELETE FROM drafts WHERE id = ?", [id]);
      return;
    }
    await db.run(
      "INSERT INTO drafts (id, operator_id, body, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
      [id, op, JSON.stringify(b), now()],
    );
  }

  async function loadDraft(id: string): Promise<DraftBody | undefined> {
    const row = await db.get<{ body: string; updated_at: number }>(
      "SELECT body, updated_at FROM drafts WHERE id = ?",
      [id],
    );
    if (row === undefined) return undefined;
    if (now() - row.updated_at > DRAFT_TTL_MS) {
      await db.run("DELETE FROM drafts WHERE id = ?", [id]);
      return undefined;
    }
    try {
      return JSON.parse(row.body) as DraftBody;
    } catch {
      await db.run("DELETE FROM drafts WHERE id = ?", [id]);
      return undefined;
    }
  }

  const apply = (b: DraftBody) => {
    store.dispatch(cartSlice.actions.restored(b));
  };

  return {
    ctx,
    /** Loads the pricing context. Call after sign-in and whenever `fingerprint` moves. */
    refresh: () => ctx.refresh(),

    /** A scanned or typed code. The whole path (decode, map lookup, price read, dispatch) is timed. */
    async scan(raw: string): Promise<AddResult> {
      const t0 = performance.now();
      const r = resolveScan(raw, {
        variantForBarcode: deps.indexes.variantForBarcode,
        ...(deps.rules === undefined ? {} : { rules: deps.rules }),
      });
      if (r.type === "unknown") return r;
      const out = await addVariant(r.variantId, r.qty, {
        ...(r.priceOverrideMinor === undefined ? {} : { priceOverrideMinor: r.priceOverrideMinor }),
      });
      metric("scan_to_line_ms", performance.now() - t0);
      return out;
    },

    addVariant,
    search: (text: string) => deps.indexes.search(text, 20),

    /** The first products by id (until per-terminal quick-key layouts are synced). */
    async favorites(limit: number): Promise<{ variantId: string; name: string; sku: string }[]> {
      const rows = await db.all<{ payload: string }>(
        "SELECT payload FROM entities WHERE dataset = 'catalog' AND entity = 'variant' ORDER BY entity_id LIMIT ?",
        [limit],
      );
      return rows.map((r) => {
        const v = JSON.parse(r.payload) as { variantId: string; name: string; sku: string };
        return { variantId: v.variantId, name: v.name, sku: v.sku };
      });
    },

    /** Re-prices the cart from local data. Null until the first sync has produced a price list. */
    pricing(): CartPricing | null {
      const t0 = performance.now();
      const c = ctx.current;
      const snapshot = ctx.snapshot();
      if (c === undefined || snapshot === undefined) return null;
      const lines = body().lines;
      try {
        const out = price(lines, c, snapshot);
        metric("add_to_totals_ms", performance.now() - t0);
        return out;
      } catch (e) {
        // A line with no price (a price was removed by a sync): show the lines, say why, never an empty cart.
        deps.onError?.(e);
        return {
          lines: lines.map((l) => ({
            id: l.id,
            name: l.name,
            detail: "No price",
            qty: Number(l.qty),
            lineTotalMinor: 0,
          })),
          totals: {
            subtotalMinor: 0,
            discountMinor: 0,
            taxMinor: 0,
            totalMinor: 0,
            itemCount: lines.length,
            currency: c.currency,
          },
          error: "A price changed. Remove the marked item or scan it again.",
        };
      }
    },

    /** Changes a quantity. Lowering one after the undo window needs a supervisor. */
    changeQty(lineId: string, qty: string): EditResult {
      const line = store.getState().cart.entities[lineId];
      const next = toQty4(qty);
      const cur = line === undefined ? undefined : toQty4(line.qty);
      if (line === undefined || next === undefined || cur === undefined || next <= 0)
        return { type: "done" };
      if (next < cur && needsOverride(line, now(), permissions())) {
        return { type: "needs_override", lineId, kind: "reduce", nextQty: qty };
      }
      store.dispatch(cartSlice.actions.lineQuantityChanged({ id: lineId, qty }));
      scheduleDraft();
      return { type: "done" };
    },

    remove(lineId: string): EditResult {
      const line = store.getState().cart.entities[lineId];
      if (line === undefined) return { type: "done" };
      if (needsOverride(line, now(), permissions())) {
        return { type: "needs_override", lineId, kind: "remove" };
      }
      store.dispatch(cartSlice.actions.lineRemoved(lineId));
      scheduleDraft();
      return { type: "done" };
    },

    /** Applies an edit a supervisor approved, and keeps the approval with the cart for the sale command. */
    applyApproved(edit: Extract<EditResult, { type: "needs_override" }>, approval: Approval): void {
      store.dispatch(cartSlice.actions.approvalRecorded(approval));
      if (edit.kind === "remove") store.dispatch(cartSlice.actions.lineRemoved(edit.lineId));
      else if (edit.nextQty !== undefined) {
        store.dispatch(
          cartSlice.actions.lineQuantityChanged({ id: edit.lineId, qty: edit.nextQty }),
        );
      }
      scheduleDraft();
    },

    setCustomer(id: string | null): void {
      store.dispatch(cartSlice.actions.customerSet(id));
      scheduleDraft();
    },

    /** Parks the cart under a new id and starts an empty one. Returns the parked id, or undefined for an empty cart. */
    async park(): Promise<string | undefined> {
      const b = body();
      const op = operatorId();
      if (b.lines.length === 0 || op === "") return undefined;
      const id = deps.newId();
      await db.run("INSERT INTO drafts (id, operator_id, body, updated_at) VALUES (?, ?, ?, ?)", [
        id,
        op,
        JSON.stringify(b),
        now(),
      ]);
      // Only what was saved leaves the cart: lines scanned while the write ran stay.
      store.dispatch(cartSlice.actions.linesRemoved(b.lines.map((l) => l.id)));
      await db.run("DELETE FROM drafts WHERE id = ?", [`current:${op}`]);
      return id;
    },

    /** Parked carts of this terminal, newest first (age and operator shown in the list). */
    async parked(): Promise<ParkedSale[]> {
      const rows = await db.all<{
        id: string;
        operator_id: string;
        updated_at: number;
        body: string;
      }>(
        "SELECT id, operator_id, updated_at, body FROM drafts WHERE id NOT LIKE 'current:%' AND updated_at >= ? ORDER BY updated_at DESC",
        [now() - DRAFT_TTL_MS],
      );
      return rows.map((r) => {
        const n = ((): number => {
          try {
            return (JSON.parse(r.body) as DraftBody).lines.reduce(
              (n, l) => n + Math.max(1, Math.round(Number(l.qty))),
              0,
            );
          } catch {
            return 0;
          }
        })();
        return { id: r.id, operatorId: r.operator_id, updatedAt: r.updated_at, itemCount: n };
      });
    },

    /** Resumes a parked cart. A non-empty current cart is parked first, so nothing is lost. */
    async resume(id: string): Promise<boolean> {
      const b = await loadDraft(id);
      if (b === undefined) return false;
      if (body().lines.length > 0) await this.park();
      apply(b);
      await db.run("DELETE FROM drafts WHERE id = ?", [id]);
      return true;
    },

    /** After a restart: brings back this operator's unfinished cart. */
    async recover(): Promise<boolean> {
      const op = operatorId();
      if (op === "") return false;
      const b = await loadDraft(`current:${op}`);
      if (b === undefined) return false;
      apply(b);
      return true;
    },

    /** Called once a sale is committed (P1-10): the cart and its recovery draft are gone. */
    async finish(): Promise<void> {
      store.dispatch(cartSlice.actions.cleared());
      const op = operatorId();
      if (op !== "") await db.run("DELETE FROM drafts WHERE id = ?", [`current:${op}`]);
    },

    flush: saveDraft,

    /** Stops this model: no draft timers, and in-flight adds are dropped. Call when the operator changes or locks. */
    dispose(): void {
      disposed = true;
      if (draftTimer !== undefined) clearTimeout(draftTimer);
      draftTimer = undefined;
    },
  };
}

export type SellModel = ReturnType<typeof createSellModel>;
