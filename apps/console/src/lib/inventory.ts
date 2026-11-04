"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api } from "./api.ts";
import { parsePrice } from "./pricing.ts";
import { STALE } from "./queries.ts";

// ---- shapes (mirror modules/inventory/src/schemas.ts) ----

export interface Balance {
  readonly locationId: string;
  readonly variantId: string;
  readonly batchId: string | null;
  readonly qty: string;
  readonly reserved: string;
  readonly available: string;
  readonly lotCode?: string | null | undefined;
  readonly expiresOn?: string | null | undefined;
  readonly salePriceMinor?: number | null | undefined;
}
export interface Threshold {
  readonly locationId: string;
  readonly variantId: string;
  readonly minQty: string;
  readonly maxQty: string | null;
  readonly lowSince: string | null;
}

export const ADJUST_REASONS = [
  { value: "damage", label: "Damaged" },
  { value: "theft", label: "Stolen" },
  { value: "loss", label: "Lost" },
  { value: "found", label: "Found" },
  { value: "count_correction", label: "Stock count correction" },
  { value: "expiry", label: "Expired" },
  { value: "writeoff", label: "Written off" },
  { value: "sample", label: "Sample given away" },
  { value: "other", label: "Other (explain below)" },
] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number]["value"];

export const stockKeys = {
  all: (t: string) => [t, "stock"] as const,
  balances: (t: string, loc: string, mode: string) => [t, "stock", "balances", loc, mode] as const,
  thresholds: (t: string, loc: string) => [t, "stock", "thresholds", loc] as const,
};

/** Balances of one location, a page of 100 at a time (a location can hold 100k variants). */
export const useBalances = (t: string, locationId: string, expiringBefore: string | null) =>
  useInfiniteQuery({
    queryKey: stockKeys.balances(t, locationId, expiringBefore ?? "all"),
    queryFn: ({ signal, pageParam }) => {
      const q = new URLSearchParams({ locationId, limit: "100" });
      if (expiringBefore !== null) {
        q.set("byBatch", "true");
        q.set("expiringBefore", expiringBefore);
      }
      if (pageParam !== null) q.set("after", pageParam);
      return api<{ items: Balance[]; nextCursor: string | null }>(
        "GET",
        `/v1/inventory/balances?${q.toString()}`,
        { signal },
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: locationId !== "",
    staleTime: STALE.list,
  });

export const useThresholds = (t: string, locationId: string) =>
  useQuery({
    queryKey: stockKeys.thresholds(t, locationId),
    queryFn: ({ signal }) =>
      api<{ thresholds: Threshold[] }>("GET", `/v1/inventory/thresholds?locationId=${locationId}`, {
        signal,
      }),
    enabled: locationId !== "",
    staleTime: STALE.list,
    select: (d) => d.thresholds,
  });

// ---- forms ----

/** A quantity as typed: up to 4 decimals. Returns the normalised text, or a message to show beside the field. */
export function parseQty(input: string, opts: { signed?: boolean } = {}): string {
  const text = input.trim().replace(/^\+/, "");
  const re = opts.signed === true ? /^-?\d{1,14}(\.\d{1,4})?$/ : /^\d{1,14}(\.\d{1,4})?$/;
  if (!re.test(text)) return "Enter a quantity like 12 or 2.5 (up to 4 decimals).";
  if (!/[1-9]/.test(text)) return "The quantity cannot be zero.";
  return text;
}
export const isQtyError = (v: string): boolean =>
  v.startsWith("Enter a quantity") || v.startsWith("The quantity");

/** Last day to count as "expiring soon", as a plain date (the API compares dates, not instants). */
export function expiryCutoff(days: number, now = new Date()): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + days));
  return d.toISOString().slice(0, 10);
}

export interface ReceiveLineDraft {
  readonly key: string;
  readonly variantId: string;
  readonly qty: string;
  readonly cost: string;
  readonly lot: string;
  readonly expiresOn: string;
  readonly salePrice: string;
}

export type ReceiveBuilt =
  | {
      readonly ok: true;
      readonly lines: readonly {
        variantId: string;
        qty: string;
        unitCostMinor: number;
        lotCode?: string;
        expiresOn?: string;
        salePriceMinor?: number;
      }[];
    }
  | { readonly ok: false; readonly errors: ReadonlyMap<string, string> };

/** Errors are keyed `<line key>.<field>` so each shows beside its input. */
export function buildReceive(
  drafts: readonly ReceiveLineDraft[],
  currency: string,
  tracksBatches: ReadonlySet<string>,
): ReceiveBuilt {
  const errors = new Map<string, string>();
  const lines: Extract<ReceiveBuilt, { ok: true }>["lines"][number][] = [];
  if (drafts.length === 0) errors.set("lines", "Add at least one product.");
  for (const d of drafts) {
    const qty = parseQty(d.qty);
    if (isQtyError(qty)) errors.set(`${d.key}.qty`, qty);
    const cost =
      d.cost.trim() === ""
        ? "Enter the unit cost (0 if it was free)."
        : parsePrice(d.cost, currency);
    if (typeof cost === "string") errors.set(`${d.key}.cost`, cost);
    let salePrice: number | null = null;
    if (d.salePrice.trim() !== "") {
      const p = parsePrice(d.salePrice, currency);
      if (typeof p === "string") errors.set(`${d.key}.salePrice`, p);
      else salePrice = p;
    }
    if (d.expiresOn !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(d.expiresOn))
      errors.set(`${d.key}.expiresOn`, "Pick a date.");
    if (tracksBatches.has(d.variantId) && d.lot.trim() === "" && d.expiresOn === "")
      errors.set(
        `${d.key}.lot`,
        "This product is tracked by batch: enter a lot code or an expiry date.",
      );
    if (typeof cost === "number" && !isQtyError(qty)) {
      lines.push({
        variantId: d.variantId,
        qty,
        unitCostMinor: cost,
        ...(d.lot.trim() === "" ? {} : { lotCode: d.lot.trim() }),
        ...(d.expiresOn === "" ? {} : { expiresOn: d.expiresOn }),
        ...(salePrice === null ? {} : { salePriceMinor: salePrice }),
      });
    }
  }
  return errors.size > 0 ? { ok: false, errors } : { ok: true, lines };
}

export interface AdjustLineDraft {
  readonly key: string;
  readonly variantId: string;
  readonly batchId: string | null;
  readonly qty: string;
}

export type AdjustBuilt =
  | {
      readonly ok: true;
      readonly lines: readonly { variantId: string; batchId: string | null; qty: string }[];
    }
  | { readonly ok: false; readonly errors: ReadonlyMap<string, string> };

/** Reason "other" needs a note; every line needs a signed non-zero quantity; one line per variant and batch. */
export function buildAdjust(
  drafts: readonly AdjustLineDraft[],
  reason: AdjustReason,
  note: string,
): AdjustBuilt {
  const errors = new Map<string, string>();
  const seen = new Set<string>();
  const lines: { variantId: string; batchId: string | null; qty: string }[] = [];
  if (drafts.length === 0) errors.set("lines", "Add at least one product.");
  if (reason === "other" && note.trim() === "") errors.set("note", "Explain what happened.");
  for (const d of drafts) {
    const qty = parseQty(d.qty, { signed: true });
    if (isQtyError(qty)) errors.set(`${d.key}.qty`, qty);
    const id = `${d.variantId}|${d.batchId ?? ""}`;
    if (seen.has(id)) errors.set(`${d.key}.qty`, "This product is already on the list.");
    seen.add(id);
    if (!isQtyError(qty)) lines.push({ variantId: d.variantId, batchId: d.batchId, qty });
  }
  return errors.size > 0 ? { ok: false, errors } : { ok: true, lines };
}

/** Days from `today` to an expiry date (negative once expired). Dates, not instants, so time zones cannot shift it. */
export function daysUntil(expiresOn: string, today = new Date()): number {
  const [y, m, d] = expiresOn.split("-").map(Number);
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1) - start) / 86_400_000);
}
