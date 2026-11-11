"use client";

import { useInfiniteQuery } from "@tanstack/react-query";

import { api } from "./api.ts";
import { checkQty, qtyUnits, unitsQty } from "./procurement.ts";
import { STALE } from "./queries.ts";

import type { Built } from "./procurement.ts";

// ---- shapes (mirror modules/inventory/src/schemas.ts: NearExpiryPage, MarkdownSuggestion, WriteOffResult, FefoReport) ----

export interface NearExpiryItem {
  readonly batchId: string;
  readonly variantId: string;
  readonly locationId: string;
  readonly lotCode: string | null;
  readonly expiresOn: string;
  readonly daysLeft: number;
  readonly qtyOnHand: string;
  readonly unitCostMinor: number;
  readonly valueMinor: number;
  readonly currency: string;
  readonly salePriceMinor: number | null;
}

export interface NearExpiryPage {
  readonly asOf: string;
  readonly days: number;
  readonly items: readonly NearExpiryItem[];
  readonly nextCursor: string | null;
}

export interface MarkdownSuggestion {
  readonly batchId: string;
  readonly variantId: string;
  readonly locationId: string;
  readonly expiresOn: string;
  readonly daysLeft: number;
  /** Suggested discount in whole percent (0 to 50). A draft: pricing decides later. */
  readonly percent: number;
  readonly state: "draft";
  readonly stockAheadQty: string;
  readonly soldQty: string;
  readonly windowDays: number;
  readonly currency: string;
  readonly salePriceMinor: number | null;
}

export interface WriteOffResult {
  readonly id: string;
  readonly locationId: string;
  readonly valueMinor: number;
  readonly currency: string;
  readonly lines: readonly {
    readonly variantId: string;
    readonly batchId: string;
    readonly qty: string;
    readonly unitCostMinor: number;
    readonly valueMinor: number;
  }[];
}

export interface FefoItem {
  readonly variantId: string;
  readonly outflows: number;
  readonly violations: number;
  readonly violatedQty: string;
}

export interface FefoReport {
  readonly from: string;
  readonly to: string;
  readonly items: readonly FefoItem[];
  readonly nextCursor: string | null;
}

/** Days choices on the near-expiry screen. The API accepts 1 to 365. */
export const EXPIRY_DAY_OPTIONS = [7, 14, 30, 60, 90] as const;
/** The API refuses a write-off for stock expiring later than this. */
export const WRITE_OFF_HORIZON_DAYS = 7;
/** The API caps the FEFO report window. */
export const FEFO_MAX_DAYS = 92;

// ---- keys and fetchers ----

export const expiryKeys = {
  all: (t: string) => [t, "expiry"] as const,
  near: (t: string, days: number, locationId: string) =>
    [t, "expiry", "near", days, locationId] as const,
  fefo: (t: string, from: string, to: string) => [t, "expiry", "fefo", from, to] as const,
};

export const useNearExpiry = (t: string, days: number, locationId: string) =>
  useInfiniteQuery({
    queryKey: expiryKeys.near(t, days, locationId),
    queryFn: ({ signal, pageParam }) => {
      const q = new URLSearchParams({ days: String(days), limit: "100" });
      if (locationId !== "") q.set("locationId", locationId);
      if (pageParam !== null) q.set("after", pageParam);
      return api<NearExpiryPage>("GET", `/v1/inventory/expiry/near-expiry?${q.toString()}`, {
        signal,
      });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const useFefo = (t: string, from: string, to: string, enabled: boolean) =>
  useInfiniteQuery({
    queryKey: expiryKeys.fefo(t, from, to),
    queryFn: ({ signal, pageParam }) => {
      const q = new URLSearchParams({ from, to, limit: "100" });
      if (pageParam !== null) q.set("after", pageParam);
      return api<FefoReport>("GET", `/v1/inventory/expiry/fefo-report?${q.toString()}`, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: STALE.reference,
  });

// ---- words and rules ----

/** Days left in words. Negative is expired; the sign is never the only cue. */
export function daysLeftText(daysLeft: number): string {
  if (daysLeft < 0) {
    const n = Math.abs(daysLeft);
    return n === 1 ? "Expired 1 day ago" : `Expired ${String(n)} days ago`;
  }
  if (daysLeft === 0) return "Expires today";
  return daysLeft === 1 ? "1 day left" : `${String(daysLeft)} days left`;
}

/** Whether the API will take a write-off for a batch with this many days left (expired counts). */
export function writeOffEligible(daysLeft: number): boolean {
  return daysLeft <= WRITE_OFF_HORIZON_DAYS;
}

export function markdownText(percent: number): string {
  return percent === 0
    ? "No markdown suggested for this batch"
    : `Suggested ${String(percent)}% off, saved as a draft`;
}

/** Plain sentence for the markdown rule's evidence: how much stock is ahead and how fast it sells. */
export function markdownEvidenceText(
  s: Pick<MarkdownSuggestion, "stockAheadQty" | "soldQty" | "windowDays">,
): string {
  return `${s.soldQty} sold in the last ${String(s.windowDays)} days against ${s.stockAheadQty} on hand`;
}

/** Rounded share of outflows that broke FEFO, and the words for it. Zero outflows is "no sales", not 0%. */
export function fefoText(item: Pick<FefoItem, "outflows" | "violations">): string {
  if (item.outflows === 0) return "No outflows in this window";
  if (item.violations === 0) return `All ${String(item.outflows)} outflows followed FEFO`;
  return `${String(item.violations)} of ${String(item.outflows)} outflows skipped an earlier batch`;
}

/** Whole-day distance between two ISO dates (to minus from). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Window of the last `days` days ending on `today` (ISO dates). Pure: the caller supplies today. */
export function defaultFefoRange(today: string, days = 30): { from: string; to: string } {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return { from: d.toISOString().slice(0, 10), to: today };
}

export function fefoRangeError(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    return "Pick both dates.";
  const span = daysBetween(from, to);
  if (span < 0) return "The end date is before the start date.";
  if (span > FEFO_MAX_DAYS) return `Pick a window of ${String(FEFO_MAX_DAYS)} days or fewer.`;
  return null;
}

// ---- write-off ----

export interface WriteOffRow {
  readonly batchId: string;
  readonly variantId: string;
  readonly locationId: string;
  readonly qtyOnHand: string;
  readonly daysLeft: number;
  /** The quantity the user typed for this batch. */
  readonly qty: string;
}

export interface WriteOffBody {
  readonly locationId: string;
  readonly note?: string;
  readonly lines: readonly { variantId: string; batchId: string; qty: string }[];
}

/**
 * Write-off body for the selected batches. One document is one location; each batch appears once; quantities are
 * within what is on hand; only batches inside the horizon. The API checks the same and refuses FEFO breaks.
 */
export function buildWriteOff(rows: readonly WriteOffRow[], note: string): Built<WriteOffBody> {
  const errors = new Map<string, string>();
  if (rows.length === 0) errors.set("lines", "Pick at least one batch to write off.");
  if (rows.length > 100) errors.set("lines", "Write off at most 100 batches at a time.");
  const locations = new Set(rows.map((r) => r.locationId));
  if (locations.size > 1) errors.set("lines", "Write off one location at a time.");
  const lines: { variantId: string; batchId: string; qty: string }[] = [];
  for (const r of rows) {
    const key = r.batchId;
    if (!writeOffEligible(r.daysLeft)) {
      errors.set(
        key,
        `Only stock expiring within ${String(WRITE_OFF_HORIZON_DAYS)} days can be written off.`,
      );
      continue;
    }
    const qty = checkQty(r.qty);
    if (!qty.ok) {
      errors.set(key, qty.message);
      continue;
    }
    if ((qtyUnits(qty.qty) ?? 0) > (qtyUnits(r.qtyOnHand) ?? 0)) {
      errors.set(key, `Only ${r.qtyOnHand} on hand.`);
      continue;
    }
    lines.push({ variantId: r.variantId, batchId: r.batchId, qty: qty.qty });
  }
  if (errors.size > 0) return { ok: false, errors };
  const text = note.trim();
  const first = rows[0];
  if (first === undefined)
    return { ok: false, errors: new Map([["lines", "Pick at least one batch."]]) };
  return {
    ok: true,
    body: { locationId: first.locationId, ...(text === "" ? {} : { note: text }), lines },
  };
}

/** Quantity text for a whole batch, used as the default when a row is picked. */
export function fullQty(qtyOnHand: string): string {
  return unitsQty(qtyUnits(qtyOnHand) ?? 0);
}
