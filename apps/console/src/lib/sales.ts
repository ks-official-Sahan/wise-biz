"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { api } from "./api.ts";
import { STALE, useMembers } from "./queries.ts";

// ---- shapes (mirror modules/sales/src/schemas.ts) ----

export interface SaleLine {
  readonly line: number;
  readonly variantId: string;
  readonly name: string;
  readonly sku: string;
  readonly qty: string;
  readonly unitPriceMinor: number;
  readonly priceSource: "override" | "batch" | "list";
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}
export interface SaleTender {
  readonly id: string;
  readonly kind: string;
  readonly amountMinor: number;
  readonly receivedMinor: number | null;
  readonly changeMinor: number | null;
  readonly card?: {
    readonly provider: string | null;
    readonly providerRef: string | null;
    readonly authCode: string | null;
    readonly brand: string | null;
  } | null;
}
export interface SaleReturn {
  readonly id: string;
  readonly returnNo: number;
  readonly totalMinor: number;
  readonly reason: string;
  readonly flags: readonly string[];
  readonly occurredAt: string;
}
export interface Sale {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly operatorId: string;
  readonly saleNo: number;
  readonly invoiceNo: string | null;
  readonly status: "completed" | "voided";
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly feeMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly cashRoundingMinor: number;
  readonly payableMinor: number;
  readonly businessDate: string;
  readonly flags: readonly string[];
  readonly completedAt: string;
  readonly lines?: readonly SaleLine[];
  readonly tenders?: readonly SaleTender[];
  readonly returns?: readonly SaleReturn[];
  readonly void?: {
    readonly id: string;
    readonly reason: string;
    readonly operatorId: string;
    readonly overrideId: string | null;
    readonly occurredAt: string;
  } | null;
}

export interface ZReport {
  readonly sales: { count: number; payableMinor: number; taxMinor: number; discountMinor: number };
  readonly voids: { count: number; payableMinor: number };
  readonly returns: { count: number; totalMinor: number };
  readonly tenders: readonly { kind: string; salesMinor: number; refundsMinor: number }[];
  readonly cash: {
    openingFloatMinor: number;
    salesMinor: number;
    refundsMinor: number;
    voidedMinor: number;
    payInMinor: number;
    payOutMinor: number;
    floatAddMinor: number;
    dropsMinor: number;
    expectedMinor: number;
    countedMinor: number;
    overShortMinor: number;
  };
  readonly drawerOpens: number;
}
export interface Shift {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly openedBy: string;
  readonly closedBy: string | null;
  readonly businessDate: string;
  readonly currency: string;
  readonly status: "open" | "closed";
  readonly openingFloatMinor: number;
  readonly expectedCashMinor: number | null;
  readonly countedCashMinor: number | null;
  readonly overShortMinor: number | null;
  readonly blindCount: boolean | null;
  readonly flags: readonly string[];
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly zReport: ZReport | null;
}

export interface SalesFilter {
  readonly branchId?: string | undefined;
  readonly status?: "completed" | "voided" | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly flagged?: boolean | undefined;
}
export interface ShiftsFilter {
  readonly branchId?: string | undefined;
  readonly status?: "open" | "closed" | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export const salesKeys = {
  all: (t: string) => [t, "sales"] as const,
  list: (t: string, f: SalesFilter) => [t, "sales", "list", f] as const,
  sale: (t: string, id: string) => [t, "sales", "sale", id] as const,
  shifts: (t: string, f: ShiftsFilter) => [t, "sales", "shifts", f] as const,
  shift: (t: string, id: string) => [t, "sales", "shift", id] as const,
};

/** Query string for the sales list; empty filters are left out so the cache key and the URL stay small. */
export function salesQuery(f: SalesFilter, after: string | null): string {
  const q = new URLSearchParams({ limit: "50" });
  if (f.branchId) q.set("branchId", f.branchId);
  if (f.status) q.set("status", f.status);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.flagged === true) q.set("flagged", "true");
  if (after !== null) q.set("after", after);
  return q.toString();
}
export function shiftsQuery(f: ShiftsFilter, after: string | null): string {
  const q = new URLSearchParams({ limit: "50" });
  if (f.branchId) q.set("branchId", f.branchId);
  if (f.status) q.set("status", f.status);
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (after !== null) q.set("after", after);
  return q.toString();
}

export const useSales = (t: string, f: SalesFilter) =>
  useInfiniteQuery({
    queryKey: salesKeys.list(t, f),
    queryFn: ({ signal, pageParam }) =>
      api<{ items: Sale[]; nextCursor: string | null }>(
        "GET",
        `/v1/sales/sales?${salesQuery(f, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const useSale = (t: string, id: string) =>
  useQuery({
    queryKey: salesKeys.sale(t, id),
    queryFn: ({ signal }) =>
      api<Sale>(
        "GET",
        `/v1/sales/sales/${encodeURIComponent(id)}?include=lines,tenders,returns,void`,
        { signal },
      ),
    staleTime: STALE.list,
  });

export const useShifts = (t: string, f: ShiftsFilter) =>
  useInfiniteQuery({
    queryKey: salesKeys.shifts(t, f),
    queryFn: ({ signal, pageParam }) =>
      api<{ items: Shift[]; nextCursor: string | null }>(
        "GET",
        `/v1/sales/shifts?${shiftsQuery(f, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const useShift = (t: string, id: string) =>
  useQuery({
    queryKey: salesKeys.shift(t, id),
    queryFn: ({ signal }) =>
      api<Shift>("GET", `/v1/sales/shifts/${encodeURIComponent(id)}`, { signal }),
    staleTime: STALE.list,
  });

// ---- display helpers ----

/** Short form of an id, for an operator who is no longer a member (a removed user). */
export const shortId = (id: string): string => `${id.slice(0, 8)}…`;

/**
 * Builds the operator id -> label map once per page. The members payload has no display name, so a member shows
 * "You" for the signed-in user and a short id for everyone else.
 */
export function operatorNames(
  members: readonly { readonly userId: string }[],
  me: string,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const m of members) names.set(m.userId, m.userId === me ? "You" : shortId(m.userId));
  return names;
}

/** Label for a sale's operator; an id missing from the map (removed user, or not loaded yet) shows as a short id. */
export function operatorLabel(operatorId: string, names: ReadonlyMap<string, string>): string {
  return names.get(operatorId) ?? shortId(operatorId);
}

/** Loads every page of members (so the map is complete) and returns the resolver map. */
export function useOperatorNames(t: string, me: string): ReadonlyMap<string, string> {
  const members = useMembers(t);
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage, data } = members;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  return useMemo(() => operatorNames(data?.pages.flatMap((p) => p.members) ?? [], me), [data, me]);
}

const FLAGS: Readonly<Record<string, string>> = {
  price_mismatch: "Price differs from the list",
  stale_price: "Priced from an old list",
  override: "Manager override used",
  offline: "Sold offline",
  over_short: "Cash over or short",
};

/** Plain words for a review flag; unknown flags are shown as written, with underscores spaced. */
export function flagLabel(flag: string): string {
  return FLAGS[flag] ?? flag.replace(/_/g, " ");
}

export type Variance = "balanced" | "over" | "short" | "unknown";

/** Over/short of a closed shift: positive is over, negative is short. */
export function variance(overShortMinor: number | null): Variance {
  if (overShortMinor === null) return "unknown";
  return overShortMinor === 0 ? "balanced" : overShortMinor > 0 ? "over" : "short";
}

const TENDER_LABEL: Readonly<Record<string, string>> = {
  cash: "Cash",
  card: "Card",
  voucher: "Voucher",
  gift_card: "Gift card",
  store_credit: "Store credit",
};
export const tenderLabel = (kind: string): string => TENDER_LABEL[kind] ?? kind.replace(/_/g, " ");

/** The drawer walk of a Z-report: what went in (positive) and out (negative) on the way to the expected count. */
export function cashWalk(z: ZReport): { label: string; minor: number }[] {
  const c = z.cash;
  return [
    { label: "Opening float", minor: c.openingFloatMinor },
    { label: "Cash sales", minor: c.salesMinor },
    { label: "Pay in", minor: c.payInMinor },
    { label: "Float added", minor: c.floatAddMinor },
    { label: "Cash refunds", minor: -c.refundsMinor },
    { label: "Voided sales", minor: -c.voidedMinor },
    { label: "Pay out", minor: -c.payOutMinor },
    { label: "Drops to safe", minor: -c.dropsMinor },
  ];
}
