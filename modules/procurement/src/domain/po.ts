import { DomainError } from "@wise-biz/errors";
import { money, multiply, sum } from "@wise-biz/money";

import { UNIT, fromQty4, toQty4 } from "./qty.ts";

/**
 * Purchase order state machine. Pure: no I/O, no clock. Every status change goes through `assertTransition`, and
 * receiving computes its next status with `applyReceipt`, which only ever returns a status the machine allows.
 */
export const PO_STATUSES = [
  "draft",
  "sent",
  "partially_received",
  "received",
  "closed",
  "cancelled",
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/** A receipt keeps a PO in its receiving state (self-loop), so over-receipt inside tolerance is a legal move. */
export const TRANSITIONS: Readonly<Record<PoStatus, readonly PoStatus[]>> = {
  draft: ["sent", "cancelled"],
  sent: ["partially_received", "received", "cancelled"],
  partially_received: ["partially_received", "received", "closed"],
  received: ["received", "closed"],
  closed: [],
  cancelled: [],
};

export const RECEIVING: readonly PoStatus[] = ["sent", "partially_received", "received"];

export function assertTransition(from: PoStatus, to: PoStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new DomainError("CONFLICT", `A purchase order cannot go from ${from} to ${to}.`);
  }
}

export interface LineFacts {
  readonly line: number;
  readonly orderedQty: string;
  readonly receivedQty: string;
  readonly unitCostMinor: number;
}

/** One line's value: qty x unit cost, rounded half up once (in @wise-biz/money), in minor units. */
export function lineTotalMinor(qty: string, unitCostMinor: number, currency: string): number {
  return multiply(
    money(unitCostMinor, currency),
    { num: Number(toQty4(qty)), den: Number(UNIT) },
    "half-up",
  ).minor;
}

/** PO total: the exact sum of its line totals (no rounding after the lines). */
export function totalMinor(
  lines: readonly { readonly qty: string; readonly unitCostMinor: number }[],
  currency: string,
): number {
  return sum(
    lines.map((l) => money(lineTotalMinor(l.qty, l.unitCostMinor, currency), currency)),
    currency,
  ).minor;
}

/** Largest receivable total for a line: ordered x (1 + tolerance), rounded down to 4 places. Integer math only. */
export function maxReceivable(orderedQty: string, tolBps: number): bigint {
  return (toQty4(orderedQty) * (10_000n + BigInt(tolBps))) / 10_000n;
}

export interface ReceiptLineIn {
  readonly line: number;
  readonly qty: string;
}

export interface ReceiptPlan {
  /** New received quantity per PO line (only lines that exist on the PO). */
  readonly received: ReadonlyMap<number, string>;
  /** `received` when every line has reached its ordered quantity, else `partially_received`. */
  readonly status: "received" | "partially_received";
}

/**
 * Check a receipt against the PO's lines and tolerance. Over-receipt is refused beyond ordered x (1 + tolerance); under
 * receipt is fine (it closes with variance). Throws VALIDATION_FAILED with a field per offending line.
 */
export function applyReceipt(
  lines: readonly LineFacts[],
  incoming: readonly ReceiptLineIn[],
  tolBps: number,
): ReceiptPlan {
  const byLine = new Map(lines.map((l) => [l.line, l]));
  const seen = new Set<number>();
  const fieldErrors: { path: string; message: string }[] = [];
  const next = new Map<number, bigint>(lines.map((l) => [l.line, toQty4(l.receivedQty)]));
  incoming.forEach((r, i) => {
    const path = `lines.${String(i)}`;
    const l = byLine.get(r.line);
    if (l === undefined)
      return fieldErrors.push({ path: `${path}.line`, message: "Not a line of this PO." });
    if (seen.has(r.line))
      return fieldErrors.push({ path: `${path}.line`, message: "Listed twice." });
    seen.add(r.line);
    const qty = toQty4(r.qty);
    if (qty <= 0n) return fieldErrors.push({ path: `${path}.qty`, message: "Must be positive." });
    const after = (next.get(r.line) ?? 0n) + qty;
    if (after > maxReceivable(l.orderedQty, tolBps)) {
      fieldErrors.push({
        path: `${path}.qty`,
        message: `Over-receipt beyond the ${String(tolBps / 100)}% tolerance (ordered ${l.orderedQty}).`,
      });
      return;
    }
    next.set(r.line, after);
  });
  if (incoming.length === 0) fieldErrors.push({ path: "lines", message: "Nothing to receive." });
  if (fieldErrors.length > 0) {
    throw new DomainError("VALIDATION_FAILED", "The receipt does not match the purchase order.", {
      fieldErrors,
    });
  }
  const full = lines.every((l) => (next.get(l.line) ?? 0n) >= toQty4(l.orderedQty));
  return {
    received: new Map([...next].map(([k, v]) => [k, fromQty4(v)])),
    status: full ? "received" : "partially_received",
  };
}

/** Under-receipt at close: ordered minus received, never negative. */
export function shortQty(orderedQty: string, receivedQty: string): string {
  const d = toQty4(orderedQty) - toQty4(receivedQty);
  return fromQty4(d > 0n ? d : 0n);
}
