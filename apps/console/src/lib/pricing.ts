"use client";

import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { uuidv7 } from "@wise-biz/ids";
import { exponentOf, format, money, parse } from "@wise-biz/money";

import { api } from "./api.ts";
import { STALE } from "./queries.ts";

// ---- shapes (mirror modules/pricing/src/schemas.ts) ----

export interface TaxRule {
  readonly id: string;
  readonly name: string;
  readonly rateBps: number;
  readonly compound: boolean;
  readonly categories: readonly string[];
  readonly order: number;
}
export interface TaxRegion {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly inclusive: boolean;
  readonly strategy: "per-line" | "per-document";
  readonly roundingMode: "half-even" | "half-up" | "up" | "down";
  readonly version: number;
  readonly rules: readonly TaxRule[];
}
export interface PriceList {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly taxRegionId: string;
  readonly branchId: string | null;
  readonly customerGroup: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly cashIncrementMinor: number | null;
  readonly version: number;
  readonly archived: boolean;
}
export interface Fee {
  readonly id: string;
  readonly name: string;
  readonly kind: "percent" | "amount";
  readonly value: number;
  readonly taxCategory: string;
  readonly active: boolean;
  readonly version: number;
}
export type Target =
  | { readonly kind: "cart" }
  | {
      readonly kind: "items";
      readonly variantIds?: readonly string[] | undefined;
      readonly categoryIds?: readonly string[] | undefined;
    };
export type Effect =
  | { readonly kind: "percent"; readonly bps: number }
  | { readonly kind: "amount"; readonly amountMinor: number }
  | { readonly kind: "fixed-price"; readonly unitPriceMinor: number }
  | { readonly kind: "bxgy"; readonly buy: number; readonly get: number; readonly getBps: number }
  | {
      readonly kind: "bundle";
      readonly components: readonly { readonly variantId: string; readonly qty: number }[];
      readonly priceMinor: number;
    };
export interface Promotion {
  readonly id: string;
  readonly name: string;
  readonly status: "draft" | "published" | "archived";
  readonly priority: number;
  readonly stackable: boolean;
  readonly target: Target;
  readonly effect: Effect;
  readonly requiresCoupon: boolean;
  readonly customerGroups: readonly string[] | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly minQty: string | null;
  readonly minAmountMinor: number | null;
  readonly version: number;
  readonly publishedAt: string | null;
}
export interface Coupon {
  readonly id: string;
  readonly promotionId: string;
  readonly code: string;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly active: boolean;
}
export interface VariantName {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly productName: string;
}

export const pricingKeys = {
  all: (t: string) => [t, "pricing"] as const,
  lists: (t: string) => [t, "pricing", "lists"] as const,
  list: (t: string, id: string) => [t, "pricing", "list", id] as const,
  prices: (t: string, id: string) => [t, "pricing", "prices", id] as const,
  regions: (t: string) => [t, "pricing", "regions"] as const,
  fees: (t: string) => [t, "pricing", "fees"] as const,
  promotions: (t: string, status: string) => [t, "pricing", "promotions", status] as const,
  promotion: (t: string, id: string) => [t, "pricing", "promotion", id] as const,
  coupons: (t: string, id: string) => [t, "pricing", "coupons", id] as const,
  variants: (t: string, ids: string) => [t, "catalog", "variant-names", ids] as const,
};

export const usePriceLists = (t: string) =>
  useQuery({
    queryKey: pricingKeys.lists(t),
    queryFn: ({ signal }) =>
      api<{ priceLists: PriceList[] }>("GET", "/v1/pricing/price-lists", { signal }),
    staleTime: STALE.list,
    select: (d) => d.priceLists,
  });

export const usePriceList = (t: string, id: string) =>
  useQuery({
    queryKey: pricingKeys.list(t, id),
    queryFn: ({ signal }) => api<PriceList>("GET", `/v1/pricing/price-lists/${id}`, { signal }),
    staleTime: 0,
  });

export const useTaxRegions = (t: string) =>
  useQuery({
    queryKey: pricingKeys.regions(t),
    queryFn: ({ signal }) =>
      api<{ taxRegions: TaxRegion[] }>("GET", "/v1/pricing/tax-regions", { signal }),
    staleTime: STALE.reference,
    select: (d) => d.taxRegions,
  });

export const useFees = (t: string) =>
  useQuery({
    queryKey: pricingKeys.fees(t),
    queryFn: ({ signal }) => api<{ fees: Fee[] }>("GET", "/v1/pricing/fees", { signal }),
    staleTime: STALE.list,
    select: (d) => d.fees,
  });

export const usePromotion = (t: string, id: string) =>
  useQuery({
    queryKey: pricingKeys.promotion(t, id),
    queryFn: ({ signal }) => api<Promotion>("GET", `/v1/pricing/promotions/${id}`, { signal }),
    staleTime: 0,
  });

export const useCoupons = (t: string, id: string, enabled: boolean) =>
  useQuery({
    queryKey: pricingKeys.coupons(t, id),
    queryFn: ({ signal }) =>
      api<{ coupons: Coupon[] }>("GET", `/v1/pricing/promotions/${id}/coupons`, { signal }),
    enabled,
    staleTime: 0,
    select: (d) => d.coupons,
  });

export const usePromotions = (t: string, status: "all" | Promotion["status"]) =>
  useInfiniteQuery({
    queryKey: pricingKeys.promotions(t, status),
    queryFn: ({ signal, pageParam }) => {
      const q = new URLSearchParams({ limit: "50" });
      if (status !== "all") q.set("status", status);
      if (pageParam !== null) q.set("after", pageParam);
      return api<{ items: Promotion[]; nextCursor: string | null }>(
        "GET",
        `/v1/pricing/promotions?${q.toString()}`,
        { signal },
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const usePricePages = (t: string, listId: string) =>
  useInfiniteQuery({
    queryKey: pricingKeys.prices(t, listId),
    queryFn: ({ signal, pageParam }) =>
      api<{
        items: { variantId: string; priceMinor: number }[];
        nextCursor: string | null;
      }>(
        "GET",
        `/v1/pricing/price-lists/${listId}/prices?${new URLSearchParams({ limit: "100", ...(pageParam === null ? {} : { after: pageParam }) }).toString()}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
  });

/** Names for variant ids, 100 per request (the price list rows show SKU and product, not ids). */
export const useVariantNames = (t: string, ids: readonly string[]) =>
  useQueries({
    queries: batches(ids, 100).map((chunk) => {
      const list = chunk.join(",");
      return {
        queryKey: pricingKeys.variants(t, list),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api<{ variants: VariantName[] }>("GET", `/v1/catalog/variants?ids=${list}`, { signal }),
        staleTime: STALE.reference,
      };
    }),
    combine: (results) =>
      new Map(results.flatMap((r) => r.data?.variants ?? []).map((v) => [v.id, v] as const)),
  });

// ---- money in forms ----

/** Parses what a person typed for a price. Returns minor units, or a message to show beside the field. */
export function parsePrice(input: string, currency: string): number | string {
  if (input.trim() === "") return "Enter a price.";
  try {
    const m = parse(input, currency);
    return m.minor < 0 ? "A price cannot be negative." : m.minor;
  } catch (e) {
    return e instanceof Error ? e.message : "Enter a valid amount.";
  }
}

export function formatPrice(minor: number, currency: string, locale = "en-US"): string {
  return format(money(minor, currency), locale);
}

/** Plain editable text for a stored price: no symbol or grouping, so it round-trips through parsePrice. */
export function priceText(minor: number, currency: string): string {
  const exponent = exponentOf(currency);
  if (exponent === 0) return String(minor);
  const digits = String(minor).padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

export const bpsText = (bps: number): string => `${String(bps / 100)}%`;

/** "12.5" → 1250 basis points. Returns a message when it is not a percentage between 0 and 100. */
export function parsePercent(input: string): number | string {
  const text = input.trim().replace(/%$/, "");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return "Enter a percentage like 10 or 12.5.";
  const bps = Math.round(Number(text) * 100);
  return bps > 10_000 ? "A percentage cannot be over 100." : bps;
}

// ---- price list editing ----

export interface PriceRow {
  readonly variantId: string;
  /** Stored price in minor units, or null when the list has none yet. */
  readonly stored: number | null;
  /** What the person typed ("" = untouched). */
  readonly edited: string | undefined;
}

export interface PriceChange {
  readonly variantId: string;
  readonly from: number | null;
  /** null removes the price. */
  readonly to: number | null;
}

export interface ChangeSet {
  readonly changes: readonly PriceChange[];
  readonly errors: ReadonlyMap<string, string>;
}

/** Turns the typed values into the changes to save. Untouched or unchanged rows are not sent. */
export function priceChanges(rows: readonly PriceRow[], currency: string): ChangeSet {
  const changes: PriceChange[] = [];
  const errors = new Map<string, string>();
  for (const r of rows) {
    if (r.edited === undefined) continue;
    if (r.edited.trim() === "") {
      if (r.stored !== null) changes.push({ variantId: r.variantId, from: r.stored, to: null });
      continue;
    }
    const parsed = parsePrice(r.edited, currency);
    if (typeof parsed === "string") {
      errors.set(r.variantId, parsed);
      continue;
    }
    if (parsed !== r.stored) changes.push({ variantId: r.variantId, from: r.stored, to: parsed });
  }
  return { changes, errors };
}

/** The API takes up to 1000 prices per call; each call raises the list version, so batches run one after another. */
export function batches<T>(items: readonly T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function summariseChanges(changes: readonly PriceChange[]): {
  added: number;
  changed: number;
  removed: number;
} {
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const c of changes) {
    if (c.to === null) removed += 1;
    else if (c.from === null) added += 1;
    else changed += 1;
  }
  return { added, changed, removed };
}

// ---- promotions ----

/** One plain sentence for what a promotion does (the list, the publish preview). */
export function describePromotion(
  p: Pick<Promotion, "target" | "effect">,
  currency: string,
): string {
  const e = p.effect;
  const what =
    e.kind === "percent"
      ? `${bpsText(e.bps)} off`
      : e.kind === "amount"
        ? `${formatPrice(e.amountMinor, currency)} off`
        : e.kind === "fixed-price"
          ? `Fixed price ${formatPrice(e.unitPriceMinor, currency)} each`
          : e.kind === "bxgy"
            ? `Buy ${String(e.buy)}, get ${String(e.get)} ${e.getBps === 10_000 ? "free" : `at ${bpsText(e.getBps)} off`}`
            : `Bundle of ${String(e.components.reduce((n, c) => n + c.qty, 0))} items for ${formatPrice(e.priceMinor, currency)}`;
  if (e.kind === "bundle") return what;
  if (p.target.kind === "cart") return `${what} the whole cart`;
  const n = (p.target.variantIds?.length ?? 0) + (p.target.categoryIds?.length ?? 0);
  return `${what} on ${String(n)} ${n === 1 ? "selection" : "selections"}`;
}

/**
 * Example for the publish preview: what a customer pays for `qty` units at `unitMinor` under this effect. It mirrors the
 * engine on a single line (the server stays the authority); the preview shows people the shape, not an exact quote.
 */
export function exampleEffect(
  effect: Effect,
  unitMinor: number,
  qty: number,
): { before: number; after: number } {
  const before = unitMinor * qty;
  let off = 0;
  if (effect.kind === "percent") off = Math.round((before * effect.bps) / 10_000);
  else if (effect.kind === "amount") off = effect.amountMinor;
  else if (effect.kind === "fixed-price") off = Math.max(0, before - effect.unitPriceMinor * qty);
  else if (effect.kind === "bxgy") {
    const group = effect.buy + effect.get;
    const free = Math.floor(qty / group) * effect.get;
    off = Math.round((free * unitMinor * effect.getBps) / 10_000);
  }
  off = Math.min(Math.max(0, off), before);
  return { before, after: before - off };
}

/** Problems that stop a draft being published; shown beside the editor before the server says the same. */
export function publishProblems(
  p: Pick<Promotion, "name" | "target" | "effect" | "startsAt" | "endsAt">,
): string[] {
  const out: string[] = [];
  if (p.name.trim() === "") out.push("Give the promotion a name.");
  if (p.target.kind === "items" && !p.target.variantIds?.length && !p.target.categoryIds?.length)
    out.push("Choose at least one product or category.");
  if (p.target.kind === "cart" && !["percent", "amount", "bundle"].includes(p.effect.kind))
    out.push("A cart promotion takes a percentage or an amount off.");
  if (p.effect.kind === "percent" && p.effect.bps === 0) out.push("The percentage is zero.");
  if (p.effect.kind === "amount" && p.effect.amountMinor === 0) out.push("The amount is zero.");
  if (p.startsAt !== null && p.endsAt !== null && p.endsAt <= p.startsAt)
    out.push("The end must be after the start.");
  return out;
}

export const newId = (): string => uuidv7();

/** datetime-local value ↔ ISO instant (the form shows local time, the API stores UTC). */
export function toLocalInput(iso: string | null): string {
  if (iso === null) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(value: string): string | null {
  if (value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- promotion draft form ----

export interface PromotionForm {
  readonly name: string;
  readonly priority: string;
  readonly stackable: boolean;
  readonly targetKind: "cart" | "items";
  readonly variantIds: readonly string[];
  readonly categoryIds: readonly string[];
  readonly effectKind: Effect["kind"];
  readonly percent: string;
  readonly amount: string;
  readonly fixedPrice: string;
  readonly buy: string;
  readonly get: string;
  readonly getPercent: string;
  readonly bundle: readonly { readonly variantId: string; readonly qty: string }[];
  readonly bundlePrice: string;
  readonly requiresCoupon: boolean;
  readonly groups: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly minQty: string;
  readonly minAmount: string;
}

export function formFromPromotion(p: Promotion, currency: string): PromotionForm {
  const e = p.effect;
  const items = p.target.kind === "items" ? p.target : null;
  return {
    name: p.name,
    priority: String(p.priority),
    stackable: p.stackable,
    targetKind: p.target.kind,
    variantIds: items?.variantIds ?? [],
    categoryIds: items?.categoryIds ?? [],
    effectKind: e.kind,
    percent: e.kind === "percent" ? String(e.bps / 100) : "10",
    amount: e.kind === "amount" ? priceText(e.amountMinor, currency) : "",
    fixedPrice: e.kind === "fixed-price" ? priceText(e.unitPriceMinor, currency) : "",
    buy: e.kind === "bxgy" ? String(e.buy) : "1",
    get: e.kind === "bxgy" ? String(e.get) : "1",
    getPercent: e.kind === "bxgy" ? String(e.getBps / 100) : "100",
    bundle:
      e.kind === "bundle"
        ? e.components.map((c) => ({ variantId: c.variantId, qty: String(c.qty) }))
        : [],
    bundlePrice: e.kind === "bundle" ? priceText(e.priceMinor, currency) : "",
    requiresCoupon: p.requiresCoupon,
    groups: (p.customerGroups ?? []).join(", "),
    startsAt: toLocalInput(p.startsAt),
    endsAt: toLocalInput(p.endsAt),
    minQty: p.minQty ?? "",
    minAmount: p.minAmountMinor === null ? "" : priceText(p.minAmountMinor, currency),
  };
}

export type BuiltPromotion =
  | {
      readonly ok: true;
      readonly body: Omit<Promotion, "id" | "status" | "version" | "publishedAt">;
    }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

const wholeNumber = (text: string, min: number, max: number): number | string => {
  if (!/^\d{1,4}$/.test(text.trim()))
    return `Enter a whole number from ${String(min)} to ${String(max)}.`;
  const n = Number(text);
  return n < min || n > max ? `Enter a whole number from ${String(min)} to ${String(max)}.` : n;
};

/** Checks the form and builds the API body. Errors are keyed by form field so each shows beside its input. */
export function buildPromotion(f: PromotionForm, currency: string): BuiltPromotion {
  const errors: Record<string, string> = {};
  const fail = (key: string, v: number | string): number => {
    if (typeof v === "string") {
      errors[key] = v;
      return 0;
    }
    return v;
  };
  if (f.name.trim() === "") errors.name = "Give the promotion a name.";
  const priority = fail("priority", intInRange(f.priority, -1000, 1000));

  let effect: Effect;
  if (f.effectKind === "percent")
    effect = { kind: "percent", bps: fail("percent", parsePercent(f.percent)) };
  else if (f.effectKind === "amount")
    effect = { kind: "amount", amountMinor: fail("amount", parsePrice(f.amount, currency)) };
  else if (f.effectKind === "fixed-price")
    effect = {
      kind: "fixed-price",
      unitPriceMinor: fail("fixedPrice", parsePrice(f.fixedPrice, currency)),
    };
  else if (f.effectKind === "bxgy")
    effect = {
      kind: "bxgy",
      buy: fail("buy", wholeNumber(f.buy, 1, 100)),
      get: fail("get", wholeNumber(f.get, 1, 100)),
      getBps: fail("getPercent", parsePercent(f.getPercent)),
    };
  else {
    const components = f.bundle.map((c, i) => ({
      variantId: c.variantId,
      qty: fail(`bundle.${String(i)}`, wholeNumber(c.qty, 1, 100)),
    }));
    if (components.length === 0) errors.bundle = "Add at least one product to the bundle.";
    effect = {
      kind: "bundle",
      components,
      priceMinor: fail("bundlePrice", parsePrice(f.bundlePrice, currency)),
    };
  }
  if (f.targetKind === "cart" && !["percent", "amount", "bundle"].includes(f.effectKind))
    errors.effectKind = "A cart promotion takes a percentage or an amount off.";

  const startsAt = fromLocalInput(f.startsAt);
  const endsAt = fromLocalInput(f.endsAt);
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt)
    errors.endsAt = "The end must be after the start.";
  let minQty: string | null = null;
  if (f.minQty.trim() !== "") {
    if (/^\d{1,14}(\.\d{1,4})?$/.test(f.minQty.trim())) minQty = f.minQty.trim();
    else errors.minQty = "Enter a quantity like 2 or 0.5.";
  }
  let minAmountMinor: number | null = null;
  if (f.minAmount.trim() !== "")
    minAmountMinor = fail("minAmount", parsePrice(f.minAmount, currency));
  const groups = f.groups
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g !== "");

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name: f.name.trim(),
      priority,
      stackable: f.stackable,
      target:
        f.targetKind === "cart"
          ? { kind: "cart" }
          : {
              kind: "items",
              ...(f.variantIds.length === 0 ? {} : { variantIds: f.variantIds }),
              ...(f.categoryIds.length === 0 ? {} : { categoryIds: f.categoryIds }),
            },
      effect,
      requiresCoupon: f.requiresCoupon,
      customerGroups: groups.length === 0 ? null : groups,
      startsAt,
      endsAt,
      minQty,
      minAmountMinor,
    },
  };
}

function intInRange(text: string, min: number, max: number): number | string {
  if (!/^-?\d{1,4}$/.test(text.trim()))
    return `Enter a whole number from ${String(min)} to ${String(max)}.`;
  const n = Number(text);
  return n < min || n > max ? `Enter a whole number from ${String(min)} to ${String(max)}.` : n;
}
