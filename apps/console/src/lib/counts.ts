"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api } from "./api.ts";
import { formatPrice } from "./pricing.ts";
import { checkQty, qtyUnits, unitsQty } from "./procurement.ts";
import { STALE } from "./queries.ts";

import type { Built } from "./procurement.ts";

// ---- shapes (mirror modules/inventory/src/schemas.ts: CountHeader, CountLine, CountDetail, Variance) ----

export type CountStatus = "draft" | "open" | "review" | "approved" | "cancelled";
export type CountKind = "full" | "cycle";
export type CountMode = "frozen" | "live";

export interface Count {
  readonly id: string;
  readonly locationId: string;
  readonly kind: CountKind;
  readonly scope: { readonly categoryIds: readonly string[]; readonly variantCount: number };
  readonly blind: boolean;
  readonly mode: CountMode;
  readonly status: CountStatus;
  readonly currency: string;
  readonly note: string;
  readonly version: number;
  readonly lineCount: number;
  readonly countedLineCount: number;
  readonly openedAt: string;
  readonly startedAt: string | null;
  readonly closedAt: string | null;
  readonly approvedAt: string | null;
  readonly cancelledAt: string | null;
}

export interface CountLine {
  readonly variantId: string;
  readonly batchId: string | null;
  readonly round: number;
  /** Scan total of the current round; null until a device counts the line. */
  readonly countedQty: string | null;
  readonly recountRequested: boolean;
  readonly note: string;
  /** Null when the API hides it (a blind count before review). */
  readonly expectedQty: string | null;
  readonly closeQty: string | null;
}

export interface CountDetail {
  readonly count: Count;
  readonly lines: readonly CountLine[];
  readonly nextCursor: string | null;
}

export interface CountVarianceLine {
  readonly variantId: string;
  readonly batchId: string | null;
  readonly countedQty: string | null;
  readonly expectedQty: string | null;
  readonly varianceQty: string | null;
  readonly unitCostMinor: number | null;
  readonly valueMinor: number | null;
}

export interface CountVariance {
  readonly count: Count;
  readonly lines: readonly CountVarianceLine[];
  readonly totals: {
    readonly shortValueMinor: number | null;
    readonly overValueMinor: number | null;
    readonly unvaluedLines: number;
  };
}

export interface CountPage {
  readonly items: readonly Count[];
  readonly nextCursor: string | null;
}

export const COUNT_STATUS_LABEL: Readonly<Record<CountStatus, string>> = {
  draft: "Draft",
  open: "Counting",
  review: "In review",
  approved: "Approved",
  cancelled: "Cancelled",
};

export const COUNT_STATUSES: readonly CountStatus[] = [
  "draft",
  "open",
  "review",
  "approved",
  "cancelled",
];

// ---- keys and fetchers ----

export const countKeys = {
  all: (t: string) => [t, "counts"] as const,
  list: (t: string, status: CountStatus | "") => [t, "counts", "list", status] as const,
  detail: (t: string, id: string) => [t, "counts", "detail", id] as const,
  variance: (t: string, id: string) => [t, "counts", "variance", id] as const,
};

/** Keyset query for count lines: the cursor is `variantId|batchId`, as the API returns it. */
export function countLinesQuery(after: string | null): string {
  const q = new URLSearchParams({ limit: "200" });
  if (after !== null) q.set("after", after);
  return q.toString();
}

export const useCounts = (t: string, status: CountStatus | "") =>
  useInfiniteQuery({
    queryKey: countKeys.list(t, status),
    queryFn: ({ signal, pageParam }) => {
      const q = new URLSearchParams({ limit: "50" });
      if (status !== "") q.set("status", status);
      if (pageParam !== null) q.set("after", pageParam);
      return api<CountPage>("GET", `/v1/inventory/counts?${q.toString()}`, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

/** One count with its lines, paged by the API. The header repeats on every page. */
export const useCount = (t: string, id: string) =>
  useInfiniteQuery({
    queryKey: countKeys.detail(t, id),
    queryFn: ({ signal, pageParam }) =>
      api<CountDetail>(
        "GET",
        `/v1/inventory/counts/${encodeURIComponent(id)}?${countLinesQuery(pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.live,
  });

export const useCountVariance = (t: string, id: string, enabled: boolean) =>
  useQuery({
    queryKey: countKeys.variance(t, id),
    queryFn: ({ signal }) =>
      api<CountVariance>("GET", `/v1/inventory/counts/${encodeURIComponent(id)}/variance`, {
        signal,
      }),
    enabled,
    staleTime: STALE.live,
  });

// ---- actions and words ----

/** Which actions a count offers in its state. The API decides too; this only hides what cannot work. */
export function countActions(status: CountStatus) {
  return {
    open: status === "draft",
    close: status === "open",
    recount: status === "open" || status === "review",
    approve: status === "review",
    cancel: status === "draft" || status === "open" || status === "review",
    gaps: status === "approved",
  };
}

/** "3 of 10 lines counted". Plain words; the progress bar is never the only signal. */
export function countProgressText(c: Pick<Count, "countedLineCount" | "lineCount">): string {
  if (c.lineCount === 0) return "No lines yet";
  return `${String(c.countedLineCount)} of ${String(c.lineCount)} lines counted`;
}

/** Whole percent of lines counted, 0 to 100, for the progress element. */
export function countProgressPercent(c: Pick<Count, "countedLineCount" | "lineCount">): number {
  if (c.lineCount === 0) return 0;
  return Math.min(100, Math.round((c.countedLineCount * 100) / c.lineCount));
}

export function lineKey(l: Pick<CountLine, "variantId" | "batchId">): string {
  return `${l.variantId}|${l.batchId ?? ""}`;
}

export function countLineStatusText(l: Pick<CountLine, "countedQty" | "recountRequested">): string {
  if (l.recountRequested) return "Recount requested";
  return l.countedQty === null ? "Not counted" : "Counted";
}

/** Expected quantity, or the reason it is not shown (a blind count hides it until review). */
export function expectedText(expectedQty: string | null): string {
  return expectedQty ?? "Hidden";
}

/** Counted minus expected, in words: "Over by 2", "Short by 1.5", "No change". */
export function countVarianceText(varianceQty: string | null): string {
  if (varianceQty === null) return "Hidden";
  const u = qtyUnits(varianceQty);
  if (u === null) return "Variance not known";
  if (u === 0) return "No change";
  return u < 0 ? `Short by ${unitsQty(-u)}` : `Over by ${unitsQty(u)}`;
}

/** Value impact of one line, in words. Hidden, unvalued and valued lines each say so. */
export function lineValueText(
  l: Pick<CountVarianceLine, "expectedQty" | "valueMinor" | "varianceQty">,
  currency: string,
): string {
  if (l.expectedQty === null) return "Hidden";
  if (l.valueMinor === null) return "No cost on file, not valued";
  const u = l.varianceQty === null ? 0 : (qtyUnits(l.varianceQty) ?? 0);
  if (u === 0) return formatPrice(0, currency);
  const word = u < 0 ? "Short" : "Over";
  return `${word} ${formatPrice(Math.abs(l.valueMinor), currency)}`;
}

/** Totals in sentences. A null total is hidden until review, never shown as zero. */
export function varianceTotalsText(
  totals: CountVariance["totals"],
  currency: string,
): { readonly short: string; readonly over: string; readonly unvalued: string } {
  const money = (v: number | null): string => (v === null ? "Hidden" : formatPrice(v, currency));
  return {
    short: `Short value ${money(totals.shortValueMinor)}`,
    over: `Over value ${money(totals.overValueMinor)}`,
    unvalued:
      totals.unvaluedLines === 0
        ? "Every line is valued"
        : `${String(totals.unvaluedLines)} lines have no cost and are not valued`,
  };
}

// ---- forms ----

export interface CountForm {
  readonly locationId: string;
  readonly kind: CountKind;
  readonly variantIds: readonly string[];
  readonly blind: boolean;
  readonly mode: CountMode;
  readonly currency: string;
  readonly note: string;
}

export interface CountBody {
  readonly locationId: string;
  readonly kind: CountKind;
  readonly scope?: { readonly variantIds: readonly string[] };
  readonly blind: boolean;
  readonly mode: CountMode;
  readonly currency: string;
  readonly note?: string;
}

/** A new count. A cycle count needs at least one product; a full count takes none. */
export function buildCount(f: CountForm): Built<CountBody> {
  const errors = new Map<string, string>();
  if (f.locationId === "") errors.set("locationId", "Pick the location to count.");
  const currency = f.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    errors.set("currency", "Enter a currency code like USD or LKR.");
  if (f.kind === "cycle" && f.variantIds.length === 0)
    errors.set("scope", "Add at least one product to a cycle count.");
  if (f.kind === "full" && f.variantIds.length > 0)
    errors.set("scope", "A full count takes no products. Pick cycle to count some products.");
  if (f.variantIds.length > 1000) errors.set("scope", "Keep a cycle count under 1000 products.");
  if (errors.size > 0) return { ok: false, errors };
  const note = f.note.trim();
  return {
    ok: true,
    body: {
      locationId: f.locationId,
      kind: f.kind,
      ...(f.kind === "cycle" ? { scope: { variantIds: [...f.variantIds] } } : {}),
      blind: f.blind,
      mode: f.mode,
      currency,
      ...(note === "" ? {} : { note }),
    },
  };
}

export interface RecountLine {
  readonly variantId: string;
  readonly batchId: string | null;
}

/** Recount request for the selected lines: one to 200. */
export function buildRecount(
  version: number,
  lines: readonly RecountLine[],
): Built<{ version: number; lines: { variantId: string; batchId: string | null }[] }> {
  if (lines.length === 0)
    return { ok: false, errors: new Map([["lines", "Pick at least one line to recount."]]) };
  if (lines.length > 200)
    return { ok: false, errors: new Map([["lines", "Pick at most 200 lines at a time."]]) };
  return {
    ok: true,
    body: {
      version,
      lines: lines.map((l) => ({ variantId: l.variantId, batchId: l.batchId })),
    },
  };
}

/** Gap case thresholds for an approved count: a quantity, a value, or both. */
export function buildGapThresholds(
  minQty: string,
  minValue: string,
  valueToMinor: (text: string) => number | string,
): Built<{ minQty?: string; minValueMinor?: number }> {
  const errors = new Map<string, string>();
  const body: { minQty?: string; minValueMinor?: number } = {};
  const q = minQty.trim();
  if (q !== "") {
    const qty = checkQty(q, true);
    if (qty.ok) body.minQty = qty.qty;
    else errors.set("minQty", qty.message);
  }
  const v = minValue.trim();
  if (v !== "") {
    const minor = valueToMinor(v);
    if (typeof minor === "number") body.minValueMinor = minor;
    else errors.set("minValueMinor", minor);
  }
  if (body.minQty === undefined && body.minValueMinor === undefined && errors.size === 0)
    errors.set("minQty", "Give a quantity, a value or both.");
  return errors.size > 0 ? { ok: false, errors } : { ok: true, body };
}
