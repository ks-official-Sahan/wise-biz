"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "./api.ts";
import { STALE } from "./queries.ts";

// ---- shapes (mirror modules/reporting/src/schemas.ts) ----

export interface SalesRow {
  readonly key: string;
  readonly currency: string;
  readonly salesCount: number;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly feeMinor: number;
  readonly taxMinor: number;
  readonly payableMinor: number;
  readonly voidsCount: number;
  readonly voidsPayableMinor: number;
  readonly returnsCount: number;
  readonly returnsMinor: number;
  readonly netMinor: number;
}
export interface ProductRow {
  readonly variantId: string;
  readonly sku: string;
  readonly currency: string;
  readonly qty: string;
  readonly revenueMinor: number;
  readonly taxMinor: number;
  readonly discountMinor: number;
  readonly costMinor: number;
  readonly netMinor: number;
  readonly profitMinor: number;
  readonly returnedQty: string;
  readonly refundMinor: number;
}
export interface PaymentRow {
  readonly kind: string;
  readonly currency: string;
  readonly count: number;
  readonly salesMinor: number;
  readonly refundsMinor: number;
  readonly netMinor: number;
}
export interface TaxRow {
  readonly day: string;
  readonly currency: string;
  readonly taxMinor: number;
  readonly payableMinor: number;
  readonly netOfTaxMinor: number;
}

export type GroupBy = "day" | "branch" | "terminal";
export interface ReportFilter {
  readonly from: string;
  readonly to: string;
  readonly branchId?: string | undefined;
}

export const reportKeys = {
  all: (t: string) => [t, "reports"] as const,
  sales: (t: string, f: ReportFilter, g: GroupBy) => [t, "reports", "sales", f, g] as const,
  products: (t: string, f: ReportFilter) => [t, "reports", "products", f] as const,
  payments: (t: string, f: ReportFilter) => [t, "reports", "payments", f] as const,
  tax: (t: string, f: ReportFilter) => [t, "reports", "tax", f] as const,
};

/** Query string for a report: the filter's empty fields are left out. */
export function reportQuery(f: ReportFilter, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ from: f.from, to: f.to, ...extra });
  if (f.branchId) q.set("branchId", f.branchId);
  return q.toString();
}

export const salesCsvUrl = (f: ReportFilter, g: GroupBy): `/v1/${string}` =>
  `/v1/reporting/sales.csv?${reportQuery(f, { groupBy: g })}`;

export const useSalesReport = (t: string, f: ReportFilter, g: GroupBy, enabled = true) =>
  useQuery({
    queryKey: reportKeys.sales(t, f, g),
    queryFn: ({ signal }) =>
      api<{ rows: SalesRow[] }>("GET", `/v1/reporting/sales?${reportQuery(f, { groupBy: g })}`, {
        signal,
      }),
    staleTime: STALE.list,
    enabled,
    select: (d) => d.rows,
  });

export const useProductsReport = (t: string, f: ReportFilter) =>
  useQuery({
    queryKey: reportKeys.products(t, f),
    queryFn: ({ signal }) =>
      api<{ rows: ProductRow[] }>(
        "GET",
        `/v1/reporting/products?${reportQuery(f, { limit: "25" })}`,
        {
          signal,
        },
      ),
    staleTime: STALE.list,
    select: (d) => d.rows,
  });

export const usePaymentsReport = (t: string, f: ReportFilter) =>
  useQuery({
    queryKey: reportKeys.payments(t, f),
    queryFn: ({ signal }) =>
      api<{ rows: PaymentRow[] }>("GET", `/v1/reporting/payments?${reportQuery(f)}`, { signal }),
    staleTime: STALE.list,
    select: (d) => d.rows,
  });

export const useTaxReport = (t: string, f: ReportFilter) =>
  useQuery({
    queryKey: reportKeys.tax(t, f),
    queryFn: ({ signal }) =>
      api<{ rows: TaxRow[] }>("GET", `/v1/reporting/tax?${reportQuery(f)}`, { signal }),
    staleTime: STALE.list,
    select: (d) => d.rows,
  });

// ---- dates (business dates are plain YYYY-MM-DD) ----

const pad = (n: number): string => String(n).padStart(2, "0");
export const isoDay = (d: Date): string =>
  `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `iso` moved by `n` calendar days, with no time zone in the way. */
export function shiftDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n));
  return `${String(t.getUTCFullYear())}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Every date from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = shiftDays(d, 1)) out.push(d);
  return out;
}

export const PRESETS = [
  { id: "today", label: "Today" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "month", label: "This month" },
  { id: "lastMonth", label: "Last month" },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

export function presetRange(id: PresetId, now = new Date()): { from: string; to: string } {
  const today = isoDay(now);
  if (id === "today") return { from: today, to: today };
  if (id === "7d") return { from: shiftDays(today, -6), to: today };
  if (id === "30d") return { from: shiftDays(today, -29), to: today };
  if (id === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: isoDay(first), to: isoDay(last) };
}

// ---- numbers ----

export interface Delta {
  readonly pct: number | null;
  readonly direction: "up" | "down" | "flat" | "new";
}

/** Change against a comparison value. No comparison (0 before) is "new", not an infinite percentage. */
export function delta(current: number, previous: number): Delta {
  if (previous === 0) return { pct: null, direction: current === 0 ? "flat" : "new" };
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  return { pct, direction: pct === 0 ? "flat" : pct > 0 ? "up" : "down" };
}

export function describeDelta(d: Delta, what: string): string {
  if (d.direction === "new") return `${what}: new, nothing to compare with`;
  if (d.direction === "flat" || d.pct === null) return `${what}: unchanged`;
  return `${what}: ${d.direction === "up" ? "up" : "down"} ${String(Math.abs(d.pct))}%`;
}

/** One value per day for a chart: missing days are zero, and only the chosen currency is counted. */
export function dailySeries(
  rows: readonly SalesRow[],
  from: string,
  to: string,
  currency: string,
  pick: (r: SalesRow) => number = (r) => r.netMinor,
): { day: string; minor: number }[] {
  const by = new Map(rows.filter((r) => r.currency === currency).map((r) => [r.key, pick(r)]));
  return eachDay(from, to).map((day) => ({ day, minor: by.get(day) ?? 0 }));
}

/** Bar geometry for a chart `width` by `height`, with a little headroom. Zero everywhere draws flat bars. */
export function bars(
  series: readonly { day: string; minor: number }[],
  width: number,
  height: number,
): { day: string; x: number; y: number; w: number; h: number }[] {
  const max = Math.max(1, ...series.map((s) => Math.max(0, s.minor)));
  const slot = width / Math.max(1, series.length);
  const w = Math.max(1, slot * 0.7);
  return series.map((s, i) => {
    const h = Math.round((Math.max(0, s.minor) / max) * height);
    return { day: s.day, x: i * slot + (slot - w) / 2, y: height - h, w, h };
  });
}

export function totals(rows: readonly SalesRow[], currency: string) {
  const mine = rows.filter((r) => r.currency === currency);
  const sum = (f: (r: SalesRow) => number) => mine.reduce((n, r) => n + f(r), 0);
  const count = sum((r) => r.salesCount);
  return {
    salesCount: count,
    payableMinor: sum((r) => r.payableMinor),
    returnsMinor: sum((r) => r.returnsMinor),
    netMinor: sum((r) => r.netMinor),
    taxMinor: sum((r) => r.taxMinor),
    discountMinor: sum((r) => r.discountMinor),
    voidsCount: sum((r) => r.voidsCount),
    averageMinor: count === 0 ? 0 : Math.round(sum((r) => r.payableMinor) / count),
  };
}
