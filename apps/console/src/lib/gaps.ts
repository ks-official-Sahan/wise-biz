"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { api } from "./api.ts";
import { formatPrice } from "./pricing.ts";
import { checkQty, qtyUnits, unitsQty } from "./procurement.ts";
import { STALE } from "./queries.ts";

import type { Built } from "./procurement.ts";

// ---- shapes (mirror modules/inventory/src/schemas.ts: GapCase, GapTask, GapEvidence, GapCaseDetail) ----

export type GapStatus = "open" | "investigating" | "resolved";
export type ResolutionCode =
  "theft" | "damage" | "data_error" | "misplaced_found" | "supplier_short";

export interface GapCase {
  readonly id: string;
  readonly countId: string;
  readonly locationId: string;
  readonly variantId: string;
  readonly batchId: string | null;
  readonly currency: string;
  /** Counted minus expected at approval: negative is short. */
  readonly varianceQty: string;
  readonly unitCostMinor: number | null;
  readonly valueMinor: number | null;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly status: GapStatus;
  readonly assigneeId: string | null;
  readonly resolutionCode: ResolutionCode | null;
  readonly resolutionNote: string;
  readonly foundLocationId: string | null;
  readonly foundQty: string | null;
  readonly version: number;
  readonly taskCount: number;
  readonly openTaskCount: number;
  readonly openedAt: string;
  readonly resolvedAt: string | null;
}

export interface GapTask {
  readonly id: string;
  readonly title: string;
  readonly assigneeId: string | null;
  readonly done: boolean;
  readonly doneAt: string | null;
  readonly createdAt: string;
}

export interface GapEvidenceItem {
  readonly source: string;
  readonly kind: string;
  readonly locationId: string;
  readonly variantId: string | null;
  readonly occurredAt: string;
  readonly qty: string | null;
  readonly actorId: string | null;
  readonly ref: string;
}

export interface GapEvidence {
  readonly items: readonly GapEvidenceItem[];
  readonly truncated: boolean;
  /** Evidence sources not wired yet: their events are missing, not zero. */
  readonly unavailable: readonly string[];
}

export interface GapCaseDetail {
  readonly case: GapCase;
  readonly tasks: readonly GapTask[];
  readonly evidence: GapEvidence;
}

export interface GapCasePage {
  readonly items: readonly GapCase[];
  readonly nextCursor: string | null;
}

export interface GapGenerateResult {
  readonly countId: string;
  /** Cases created by this call. A replay creates none. */
  readonly created: number;
  /** Lines over the thresholds that already had a case. */
  readonly existing: number;
}

export interface GapTaskResult {
  readonly task: GapTask;
  readonly case: GapCase;
}

export const GAP_STATUS_LABEL: Readonly<Record<GapStatus, string>> = {
  open: "Open",
  investigating: "Investigating",
  resolved: "Resolved",
};

export const GAP_STATUSES: readonly GapStatus[] = ["open", "investigating", "resolved"];

export const RESOLUTION_LABEL: Readonly<Record<ResolutionCode, string>> = {
  theft: "Theft",
  damage: "Damage",
  data_error: "Data error",
  misplaced_found: "Misplaced, found",
  supplier_short: "Supplier short",
};

export const RESOLUTION_CODES: readonly ResolutionCode[] = [
  "theft",
  "damage",
  "data_error",
  "misplaced_found",
  "supplier_short",
];

// ---- keys and fetchers ----

export const gapKeys = {
  all: (t: string) => [t, "gaps"] as const,
  list: (t: string, status: GapStatus | "") => [t, "gaps", "list", status] as const,
  detail: (t: string, id: string) => [t, "gaps", "detail", id] as const,
};

export const useGaps = (t: string, status: GapStatus | "") =>
  useInfiniteQuery({
    queryKey: gapKeys.list(t, status),
    queryFn: ({ signal, pageParam }) => {
      const q = new URLSearchParams({ limit: "50" });
      if (status !== "") q.set("status", status);
      if (pageParam !== null) q.set("after", pageParam);
      return api<GapCasePage>("GET", `/v1/inventory/gap-cases?${q.toString()}`, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: STALE.list,
  });

export const useGap = (t: string, id: string) =>
  useQuery({
    queryKey: gapKeys.detail(t, id),
    queryFn: ({ signal }) =>
      api<GapCaseDetail>("GET", `/v1/inventory/gap-cases/${encodeURIComponent(id)}`, { signal }),
    staleTime: STALE.live,
  });

// ---- actions and words ----

/** Which actions a case offers in its state. Resolved cases are read-only. */
export function gapActions(status: GapStatus) {
  const live = status !== "resolved";
  return {
    investigate: status === "open",
    assign: live,
    addTask: live,
    resolve: live,
  };
}

/** Shortage in words: "Short by 3", "Over by 1", "No change". Text, never colour alone. */
export function gapVarianceText(varianceQty: string): string {
  const u = qtyUnits(varianceQty);
  if (u === null) return "Variance not known";
  if (u === 0) return "No change";
  return u < 0 ? `Short by ${unitsQty(-u)}` : `Over by ${unitsQty(u)}`;
}

/** The shortage as a positive quantity (0 when the line is not short). */
export function shortageQty(varianceQty: string): string {
  const u = qtyUnits(varianceQty) ?? 0;
  return unitsQty(Math.max(0, -u));
}

/** Value of the case in words. Unknown cost is "not valued", never zero. */
export function gapValueText(valueMinor: number | null, currency: string): string {
  return valueMinor === null ? "No cost on file, not valued" : formatPrice(valueMinor, currency);
}

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  ledger: "Stock ledger",
  sales: "Sales",
};

/** Plain name for an evidence source. Unknown sources show their raw name. */
export function evidenceSourceText(source: string): string {
  return SOURCE_LABEL[source] ?? source.replace(/_/g, " ");
}

/** Sentence for sources not wired yet, so an empty evidence list is not read as "nothing happened". */
export function unavailableText(unavailable: readonly string[]): string | null {
  if (unavailable.length === 0) return null;
  const names = unavailable.map((u) => u.replace(/_/g, " ")).join(", ");
  return `Not checked yet: ${names}. Their events are missing from this list, not zero.`;
}

export function assigneeText(assigneeId: string | null): string {
  return assigneeId === null ? "Unassigned" : `Member ${assigneeId.slice(0, 8)}…`;
}

// ---- forms ----

export interface ResolveForm {
  readonly code: ResolutionCode | "";
  readonly note: string;
  readonly foundLocationId: string;
  readonly foundQty: string;
}

export interface ResolveBody {
  readonly version: number;
  readonly code: ResolutionCode;
  readonly note?: string;
  readonly foundLocationId?: string;
  readonly foundQty?: string;
}

/**
 * Resolution body. Misplaced-found needs a location and a quantity no larger than the shortage; every other code
 * takes neither. The API checks the same rules; this only gives the message before the request.
 */
export function buildResolve(
  version: number,
  f: ResolveForm,
  shortage: string,
): Built<ResolveBody> {
  const errors = new Map<string, string>();
  if (f.code === "") errors.set("code", "Pick a resolution.");
  const note = f.note.trim();
  if (note.length > 500) errors.set("note", "Keep the note to 500 characters.");
  if (f.code === "misplaced_found") {
    if (f.foundLocationId === "") errors.set("foundLocationId", "Pick where the stock was found.");
    const qty = checkQty(f.foundQty);
    if (!qty.ok) errors.set("foundQty", qty.message);
    else if ((qtyUnits(qty.qty) ?? 0) > (qtyUnits(shortage) ?? 0))
      errors.set("foundQty", `At most the shortage, ${shortage}.`);
  }
  if (errors.size > 0) return { ok: false, errors };
  if (f.code === "") return { ok: false, errors: new Map([["code", "Pick a resolution."]]) };
  if (f.code === "misplaced_found") {
    const qty = checkQty(f.foundQty);
    return {
      ok: true,
      body: {
        version,
        code: f.code,
        ...(note === "" ? {} : { note }),
        foundLocationId: f.foundLocationId,
        foundQty: qty.ok ? qty.qty : "0",
      },
    };
  }
  return { ok: true, body: { version, code: f.code, ...(note === "" ? {} : { note }) } };
}

/** A manual task: one line of title, optional assignee. */
export function buildTask(
  version: number,
  title: string,
  assigneeId: string | null,
): Built<{ version: number; title: string; assigneeId?: string }> {
  const t = title.trim();
  if (t === "") return { ok: false, errors: new Map([["title", "Name the task."]]) };
  if (t.length > 200)
    return { ok: false, errors: new Map([["title", "Keep the task to 200 characters."]]) };
  return {
    ok: true,
    body: { version, title: t, ...(assigneeId === null ? {} : { assigneeId }) },
  };
}
