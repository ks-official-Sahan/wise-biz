"use client";

import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { isCurrency, money, multiply } from "@wise-biz/money";
import { useEffect, useMemo, useRef } from "react";

import { ApiError, api } from "./api.ts";
import { formatPrice, newId, parsePrice } from "./pricing.ts";
import { STALE, keys } from "./queries.ts";

import type { Location } from "./types.ts";

// ---- shapes (mirror modules/procurement/src/schemas.ts) ----

export type PoStatus =
  "draft" | "sent" | "partially_received" | "received" | "closed" | "cancelled";
export type TransferStatus = "requested" | "dispatched" | "received" | "closed" | "cancelled";

export interface Supplier {
  readonly id: string;
  readonly name: string;
  readonly contactName: string;
  readonly email: string;
  readonly phone: string;
  readonly address: string;
  readonly paymentTermsDays: number;
  readonly leadTimeDays: number;
  readonly currency: string;
  readonly archivedAt: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

export interface PoLine {
  readonly line: number;
  readonly variantId: string;
  readonly orderedQty: string;
  readonly receivedQty: string;
  readonly shortQty: string;
  readonly unitCostMinor: number;
  readonly lineTotalMinor: number;
}

export interface PurchaseOrder {
  readonly id: string;
  readonly poNo: number;
  readonly supplierId: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly currency: string;
  readonly status: PoStatus;
  readonly expectedOn: string | null;
  readonly notes: string;
  readonly totalMinor: number;
  readonly version: number;
  readonly sentAt: string | null;
  readonly closedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly PoLine[];
}

export interface TransferLine {
  readonly line: number;
  readonly variantId: string;
  readonly requestedQty: string;
  readonly dispatchedQty: string;
  readonly receivedQty: string;
  readonly varianceQty: string;
  readonly valueMinor: number;
}

export interface Transfer {
  readonly id: string;
  readonly transferNo: number;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly status: TransferStatus;
  readonly notes: string;
  readonly currency: string | null;
  readonly inTransitQty: string;
  readonly inTransitValueMinor: number;
  readonly version: number;
  readonly dispatchedAt: string | null;
  readonly receivedAt: string | null;
  readonly closedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly TransferLine[];
}

// ---- keys and fetchers ----

export const procurementKeys = {
  all: (t: string) => [t, "procurement"] as const,
  suppliers: (t: string, archived: boolean) => [t, "procurement", "suppliers", archived] as const,
  supplierNames: (t: string) => [t, "procurement", "supplier-names"] as const,
  pos: (t: string, status: PoStatus | "") => [t, "procurement", "pos", status] as const,
  po: (t: string, id: string) => [t, "procurement", "po", id] as const,
  transfers: (t: string, status: TransferStatus | "") =>
    [t, "procurement", "transfers", status] as const,
  transfer: (t: string, id: string) => [t, "procurement", "transfer", id] as const,
};

const PAGE_SIZE = "50";

/** Query string for a keyset page: the API pages by `after` (the last id), and answers `nextCursor`. */
function pageQuery(params: Record<string, string>, after: string | null): string {
  const q = new URLSearchParams({ limit: PAGE_SIZE, ...params });
  if (after !== null) q.set("after", after);
  return q.toString();
}
export const supplierQuery = (includeArchived: boolean, after: string | null): string =>
  pageQuery({ includeArchived: String(includeArchived) }, after);
export const poQuery = (status: PoStatus | "", after: string | null): string =>
  pageQuery(status === "" ? {} : { status }, after);
export const transferQuery = (status: TransferStatus | "", after: string | null): string =>
  pageQuery(status === "" ? {} : { status }, after);

export const useSuppliers = (t: string, includeArchived: boolean) =>
  useInfiniteQuery({
    queryKey: procurementKeys.suppliers(t, includeArchived),
    queryFn: ({ signal, pageParam }) =>
      api<{ items: Supplier[]; nextCursor: string | null }>(
        "GET",
        `/v1/procurement/suppliers?${supplierQuery(includeArchived, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const usePos = (t: string, status: PoStatus | "") =>
  useInfiniteQuery({
    queryKey: procurementKeys.pos(t, status),
    queryFn: ({ signal, pageParam }) =>
      api<{ items: PurchaseOrder[]; nextCursor: string | null }>(
        "GET",
        `/v1/procurement/purchase-orders?${poQuery(status, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const usePo = (t: string, id: string) =>
  useQuery({
    queryKey: procurementKeys.po(t, id),
    queryFn: ({ signal }) =>
      api<PurchaseOrder>("GET", `/v1/procurement/purchase-orders/${encodeURIComponent(id)}`, {
        signal,
      }),
    staleTime: STALE.live,
  });

export const useTransfers = (t: string, status: TransferStatus | "") =>
  useInfiniteQuery({
    queryKey: procurementKeys.transfers(t, status),
    queryFn: ({ signal, pageParam }) =>
      api<{ items: Transfer[]; nextCursor: string | null }>(
        "GET",
        `/v1/procurement/transfers?${transferQuery(status, pageParam)}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const useTransfer = (t: string, id: string) =>
  useQuery({
    queryKey: procurementKeys.transfer(t, id),
    queryFn: ({ signal }) =>
      api<Transfer>("GET", `/v1/procurement/transfers/${encodeURIComponent(id)}`, { signal }),
    staleTime: STALE.live,
  });

/** Every supplier (archived too) keyed by id, so rows can show a name. Loads all pages, 200 at a time. */
export function useSupplierNames(t: string): ReadonlyMap<string, Supplier> {
  const q = useInfiniteQuery({
    queryKey: procurementKeys.supplierNames(t),
    queryFn: ({ signal, pageParam }) => {
      const qs = new URLSearchParams({ limit: "200", includeArchived: "true" });
      if (pageParam !== null) qs.set("after", pageParam);
      return api<{ items: Supplier[]; nextCursor: string | null }>(
        "GET",
        `/v1/procurement/suppliers?${qs.toString()}`,
        { signal },
      );
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.reference,
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage, data } = q;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  return useMemo(
    () => new Map((data?.pages.flatMap((p) => p.items) ?? []).map((s) => [s.id, s] as const)),
    [data],
  );
}

/** Locations of several branches at once (a transfer can run between branches), sharing the cache of useLocations. */
export function useAllLocations(t: string, branchIds: readonly string[]): readonly Location[] {
  const results = useQueries({
    queries: branchIds.map((branchId) => ({
      queryKey: keys.locations(t, branchId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<{ locations: Location[] }>(
          "GET",
          `/v1/tenancy/branches/${encodeURIComponent(branchId)}/locations`,
          { signal },
        ),
      staleTime: STALE.reference,
    })),
    combine: (rs) => rs.flatMap((r) => r.data?.locations ?? []),
  });
  return results;
}

// ---- status words ----

export const PO_STATUS_LABEL: Readonly<Record<PoStatus, string>> = {
  draft: "Draft",
  sent: "Sent",
  partially_received: "Partly received",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
};

export const TRANSFER_STATUS_LABEL: Readonly<Record<TransferStatus, string>> = {
  requested: "Requested",
  dispatched: "In transit",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
};

/** Which actions a purchase order offers in its current state. The API decides too; this only hides what cannot work. */
export function poActions(po: Pick<PurchaseOrder, "status" | "lines">) {
  const untouched = po.lines.every((l) => qtyUnits(l.receivedQty) === 0);
  return {
    send: po.status === "draft",
    receive: po.status === "sent" || po.status === "partially_received",
    close: po.status === "partially_received" || po.status === "received",
    cancel: po.status === "draft" || (po.status === "sent" && untouched),
  };
}

/** Which actions a transfer offers in its current state. */
export function transferActions(t: Pick<Transfer, "status">) {
  return {
    dispatch: t.status === "requested",
    cancel: t.status === "requested",
    receive: t.status === "dispatched",
    close: t.status === "received",
  };
}

// ---- quantities (ten-thousandths, so 4 decimal places stay exact) ----

const SCALE = 10_000;
const POS_QTY = /^(?!0+(\.0+)?$)\d{1,9}(\.\d{1,4})?$/;
const ANY_QTY = /^\d{1,9}(\.\d{1,4})?$/;
const SIGNED_QTY = /^-?\d{1,9}(\.\d{1,4})?$/;
/** The server's over-receipt tolerance default (5%). The API is the authority; this only warns early. */
export const OVER_RECEIPT_PERCENT = 5;

/** A quantity string as ten-thousandths (signed). Null when the text is not a quantity the API accepts. */
export function qtyUnits(qty: string): number | null {
  if (!SIGNED_QTY.test(qty)) return null;
  const neg = qty.startsWith("-");
  const [whole = "0", frac = ""] = (neg ? qty.slice(1) : qty).split(".");
  const units = Number(whole) * SCALE + Number(frac.padEnd(4, "0"));
  return neg ? -units : units;
}

/** Ten-thousandths back to plain text: 12500 -> "1.25", 3 -> "0.0003", -20000 -> "-2". */
export function unitsQty(units: number): string {
  const abs = Math.abs(units);
  const whole = Math.floor(abs / SCALE);
  const frac = abs % SCALE;
  const text =
    frac === 0
      ? String(whole)
      : `${String(whole)}.${String(frac).padStart(4, "0").replace(/0+$/, "")}`;
  return units < 0 ? `-${text}` : text;
}

export type QtyCheck =
  { readonly ok: true; readonly qty: string } | { readonly ok: false; readonly message: string };

/** A quantity as typed: positive (or zero when the screen allows it). Up to 9 whole digits and 4 decimals. */
export function checkQty(input: string, allowZero = false): QtyCheck {
  const text = input.trim();
  if ((allowZero ? ANY_QTY : POS_QTY).test(text)) return { ok: true, qty: text };
  return {
    ok: false,
    message: allowZero
      ? "Enter a quantity like 2 or 2.5 (up to 4 decimals)."
      : "Enter a quantity above zero, like 12 or 2.5 (up to 4 decimals).",
  };
}

/** Line total in minor units for a decimal quantity. Rounding goes through @wise-biz/money (half-even). Preview only. */
export function lineTotalMinor(
  unitCostMinor: number,
  qty: string,
  currency: string,
): number | null {
  const u = qtyUnits(qty);
  if (u === null || u < 0) return null;
  return multiply(money(unitCostMinor, currency), { num: u, den: SCALE }).minor;
}

/** Warns when a receipt would take the line past the tolerance. A hint: the server decides. */
export function overReceiptHint(
  orderedQty: string,
  receivedQty: string,
  addQty: string,
): string | null {
  const o = qtyUnits(orderedQty);
  const r = qtyUnits(receivedQty);
  const a = qtyUnits(addQty);
  if (o === null || r === null || a === null) return null;
  return (r + a) * 100 > o * (100 + OVER_RECEIPT_PERCENT)
    ? `This takes the line more than ${String(OVER_RECEIPT_PERCENT)}% over the ordered quantity. The server may refuse it.`
    : null;
}

/** Open quantity on a PO line (ordered minus received, never below zero). */
export function openQty(orderedQty: string, receivedQty: string): string {
  const o = qtyUnits(orderedQty) ?? 0;
  const r = qtyUnits(receivedQty) ?? 0;
  return unitsQty(Math.max(0, o - r));
}

/**
 * Plain words for a transfer variance (received minus dispatched; negative is short). Text, never colour alone.
 */
export function varianceText(varianceQty: string): string {
  const u = qtyUnits(varianceQty);
  if (u === null) return "Variance not known";
  if (u === 0) return "Received in full";
  return u < 0 ? `Short by ${unitsQty(-u)}` : `Over by ${unitsQty(u)}`;
}

/** Hint for the receive form while typing: received against dispatched. */
export function receiveHint(dispatchedQty: string, receivedQty: string): string | null {
  const d = qtyUnits(dispatchedQty);
  const r = qtyUnits(receivedQty);
  if (d === null || r === null || r === d) return null;
  return varianceText(unitsQty(r - d));
}

/** Money for in-transit stock. A transfer has no currency until it is dispatched, so the value waits for it. */
export function inTransitText(
  t: Pick<Transfer, "inTransitQty" | "inTransitValueMinor" | "currency">,
): string {
  if (qtyUnits(t.inTransitQty) === 0) return "Nothing in transit";
  const qty = `${t.inTransitQty} in transit`;
  return t.currency === null ? qty : `${qty}, ${formatPrice(t.inTransitValueMinor, t.currency)}`;
}

// ---- forms ----

export type Built<T> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly errors: ReadonlyMap<string, string> };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const DAYS_RE = /^\d{1,3}$/;

export interface SupplierForm {
  readonly name: string;
  readonly contactName: string;
  readonly email: string;
  readonly phone: string;
  readonly address: string;
  readonly paymentTermsDays: string;
  readonly leadTimeDays: string;
  readonly currency: string;
}

export interface SupplierBody {
  readonly name: string;
  readonly contactName: string;
  readonly email: string;
  readonly phone: string;
  readonly address: string;
  readonly paymentTermsDays: number;
  readonly leadTimeDays: number;
  readonly currency: string;
}

export function buildSupplier(f: SupplierForm): Built<SupplierBody> {
  const errors = new Map<string, string>();
  const name = f.name.trim();
  const email = f.email.trim();
  const currency = f.currency.trim().toUpperCase();
  if (name === "") errors.set("name", "Enter the supplier's name.");
  if (name.length > 120) errors.set("name", "Keep the name to 120 characters.");
  if (email !== "" && !EMAIL_RE.test(email))
    errors.set("email", "Enter an email like orders@example.com.");
  if (!isCurrency(currency)) errors.set("currency", "Enter a currency code like USD or LKR.");
  const days = (key: string, raw: string, label: string): number => {
    const v = raw.trim();
    if (!DAYS_RE.test(v) || Number(v) > 365) {
      errors.set(key, `${label} is a whole number of days, 0 to 365.`);
      return 0;
    }
    return Number(v);
  };
  const paymentTermsDays = days("paymentTermsDays", f.paymentTermsDays, "Payment terms");
  const leadTimeDays = days("leadTimeDays", f.leadTimeDays, "Lead time");
  if (errors.size > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name,
      contactName: f.contactName.trim(),
      email,
      phone: f.phone.trim(),
      address: f.address.trim(),
      paymentTermsDays,
      leadTimeDays,
      currency,
    },
  };
}

export interface DraftLine {
  readonly key: string;
  readonly variantId: string;
  readonly qty: string;
  readonly cost: string;
}

export interface PoForm {
  readonly supplierId: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly expectedOn: string;
  readonly notes: string;
  readonly lines: readonly DraftLine[];
}

export interface PoBody {
  readonly supplierId: string;
  readonly branchId: string;
  readonly locationId: string;
  readonly expectedOn: string | null;
  readonly notes: string;
  readonly lines: readonly { variantId: string; orderedQty: string; unitCostMinor: number }[];
}

/** Lines keyed `<line key>.<field>` (and `lines` for the whole list), so each message sits beside its input. */
function checkUniqueVariants(lines: readonly DraftLine[], errors: Map<string, string>): void {
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.variantId))
      errors.set(`${l.key}.variantId`, "This product is already on a line.");
    seen.add(l.variantId);
  }
}

export function buildPo(f: PoForm, currency: string): Built<PoBody> {
  const errors = new Map<string, string>();
  if (f.supplierId === "") errors.set("supplierId", "Pick a supplier.");
  if (f.locationId === "") errors.set("locationId", "Pick a location to receive into.");
  const expected = f.expectedOn.trim();
  if (expected !== "" && !DATE_RE.test(expected)) errors.set("expectedOn", "Pick a date.");
  if (f.lines.length === 0) errors.set("lines", "Add at least one product.");
  checkUniqueVariants(f.lines, errors);
  const lines: { variantId: string; orderedQty: string; unitCostMinor: number }[] = [];
  for (const l of f.lines) {
    const qty = checkQty(l.qty);
    if (!qty.ok) errors.set(`${l.key}.qty`, qty.message);
    const cost =
      l.cost.trim() === ""
        ? "Enter the unit cost (0 if it was free)."
        : parsePrice(l.cost, currency);
    if (typeof cost === "string") errors.set(`${l.key}.cost`, cost);
    if (qty.ok && typeof cost === "number")
      lines.push({ variantId: l.variantId, orderedQty: qty.qty, unitCostMinor: cost });
  }
  if (errors.size > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      supplierId: f.supplierId,
      branchId: f.branchId,
      locationId: f.locationId,
      expectedOn: expected === "" ? null : expected,
      notes: f.notes.trim(),
      lines,
    },
  };
}

export interface TransferForm {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly notes: string;
  readonly lines: readonly { key: string; variantId: string; qty: string }[];
}

export interface TransferBody {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly notes: string;
  readonly lines: readonly { variantId: string; requestedQty: string }[];
}

export function buildTransfer(f: TransferForm): Built<TransferBody> {
  const errors = new Map<string, string>();
  if (f.fromLocationId === "") errors.set("fromLocationId", "Pick the location to send from.");
  if (f.toLocationId === "") errors.set("toLocationId", "Pick the location to send to.");
  else if (f.toLocationId === f.fromLocationId)
    errors.set("toLocationId", "Pick a different destination.");
  if (f.lines.length === 0) errors.set("lines", "Add at least one product.");
  const seen = new Set<string>();
  const lines: { variantId: string; requestedQty: string }[] = [];
  for (const l of f.lines) {
    if (seen.has(l.variantId))
      errors.set(`${l.key}.variantId`, "This product is already on a line.");
    seen.add(l.variantId);
    const qty = checkQty(l.qty);
    if (!qty.ok) errors.set(`${l.key}.qty`, qty.message);
    else lines.push({ variantId: l.variantId, requestedQty: qty.qty });
  }
  if (errors.size > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      fromLocationId: f.fromLocationId,
      toLocationId: f.toLocationId,
      notes: f.notes.trim(),
      lines,
    },
  };
}

/**
 * Line quantities typed on a receive or dispatch form. `skipBlank` drops untouched lines (a PO receipt can cover some
 * lines only); otherwise every line needs a value (a transfer covers the whole transfer).
 */
export function buildLineQty(
  rows: readonly { readonly line: number; readonly value: string }[],
  opts: { readonly allowZero: boolean; readonly skipBlank: boolean },
): Built<{ line: number; qty: string }[]> {
  const errors = new Map<string, string>();
  const out: { line: number; qty: string }[] = [];
  for (const r of rows) {
    if (r.value.trim() === "" && opts.skipBlank) continue;
    const qty = checkQty(r.value, opts.allowZero);
    if (qty.ok) out.push({ line: r.line, qty: qty.qty });
    else errors.set(`line-${String(r.line)}`, qty.message);
  }
  if (out.length === 0 && errors.size === 0)
    errors.set("lines", "Enter the quantity for at least one line.");
  return errors.size > 0 ? { ok: false, errors } : { ok: true, body: out };
}

// ---- errors ----

/** What a failed action says. 404 is "not allowed or gone" (unauthorised reads 404); 409 is a version clash. */
export function actionErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "You may not do this, or it is already gone.";
    if (err.status === 409)
      return "This changed while you were looking. It has been reloaded. Check it and try again.";
    if (err.status === 422) return err.problem.detail ?? "Check the highlighted fields.";
    return err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

/**
 * One idempotency key per request body, as the receive form does: a retry of the same body replays on the server, a
 * changed body is a new request. Call it from the submit handler, never during render.
 */
export function useAttemptKey(): (signature: string) => string {
  const attempt = useRef<{ readonly id: string; readonly sig: string } | null>(null);
  return (signature) => {
    if (attempt.current?.sig !== signature) attempt.current = { id: newId(), sig: signature };
    return attempt.current.id;
  };
}

/**
 * Remembers the control that opened a dialog, so closing it puts focus back there (the dialog is unmounted on close,
 * which would otherwise drop focus to the page body).
 */
export function useReturnFocus(): {
  readonly remember: (el: EventTarget) => void;
  readonly restore: () => void;
} {
  const opener = useRef<HTMLElement | null>(null);
  return {
    remember: (el) => {
      opener.current = el instanceof HTMLElement ? el : null;
    },
    restore: () => {
      const node = opener.current;
      requestAnimationFrame(() => {
        node?.focus();
      });
    },
  };
}
