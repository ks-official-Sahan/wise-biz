"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "./api.ts";
import { presence } from "./devices.ts";
import { STALE } from "./queries.ts";
import { reportKeys, reportQuery } from "./reports.ts";

import type { Device } from "./devices.ts";
import type { ProductRow, ReportFilter, SalesRow } from "./reports.ts";

/**
 * The home numbers refresh on this interval. TanStack pauses polling while the tab is hidden (refetchIntervalInBackground
 * defaults to false), so a background tab costs nothing.
 */
export const LIVE_MS = 30_000;

/** A clock that ticks every `ms`, so "online" stays honest between refetches. */
export function useNow(ms: number = LIVE_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, ms);
    return () => {
      clearInterval(id);
    };
  }, [ms]);
  return now;
}

/**
 * Today's sales by day, the same query key as useSalesReport (so the cache is shared) with a live refetch.
 * Reads rollups only: the API answers from the daily rollup tables, never the raw sales.
 */
export const useLiveSales = (t: string, f: ReportFilter, enabled: boolean) =>
  useQuery({
    queryKey: reportKeys.sales(t, f, "day"),
    queryFn: ({ signal }) =>
      api<{ rows: SalesRow[] }>(
        "GET",
        `/v1/reporting/sales?${reportQuery(f, { groupBy: "day" })}`,
        {
          signal,
        },
      ),
    staleTime: STALE.list,
    refetchInterval: LIVE_MS,
    enabled,
    select: (d) => d.rows,
  });

/** Products for the day, the same query key as useProductsReport, refetched live. */
export const useLiveProducts = (t: string, f: ReportFilter, enabled: boolean) =>
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
    refetchInterval: LIVE_MS,
    enabled,
    select: (d) => d.rows,
  });

/**
 * Terminals online by the devices page rule: active, and seen within the presence window (devices.ts presence()).
 * Pending, suspended, revoked and never-seen terminals do not count.
 */
export function onlineTerminals(devices: readonly Device[], now: number): number {
  return devices.filter((d) => d.status === "active" && presence(d, now) === "online").length;
}

/**
 * Top `n` products by net for one currency, highest first. The API already returns revenue order; this re-sorts by net
 * so the card matches its label. Ties fall back to variant id so the order is stable. Never mutates its input.
 */
export function topProducts(rows: readonly ProductRow[], currency: string, n = 5): ProductRow[] {
  return rows
    .filter((r) => r.currency === currency)
    .sort((a, b) => b.netMinor - a.netMinor || a.variantId.localeCompare(b.variantId))
    .slice(0, Math.max(0, n));
}

/** The API's product report has no name, so show the SKU, or the end of the variant id when there is none. */
export const productLabel = (r: Pick<ProductRow, "sku" | "variantId">): string =>
  r.sku.trim() === "" ? `Product …${r.variantId.slice(-6)}` : r.sku;
