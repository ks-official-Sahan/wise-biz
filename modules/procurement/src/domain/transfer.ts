import { DomainError } from "@wise-biz/errors";

import { fromQty4, toQty4 } from "./qty.ts";

/**
 * Stock transfer state machine. Pure: no I/O, no clock. Every status change goes through `assertTransferTransition`.
 * requested -> dispatched -> received -> closed; a requested transfer may be cancelled instead.
 */
export const TRANSFER_STATUSES = [
  "requested",
  "dispatched",
  "received",
  "closed",
  "cancelled",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_TRANSITIONS: Readonly<Record<TransferStatus, readonly TransferStatus[]>> = {
  requested: ["dispatched", "cancelled"],
  dispatched: ["received"],
  received: ["closed"],
  closed: [],
  cancelled: [],
};

export function assertTransferTransition(from: TransferStatus, to: TransferStatus): void {
  if (!TRANSFER_TRANSITIONS[from].includes(to)) {
    throw new DomainError("CONFLICT", `A transfer cannot go from ${from} to ${to}.`);
  }
}

export function assertDistinctLocations(from: string, to: string): void {
  if (from === to) {
    throw new DomainError("VALIDATION_FAILED", "The destination must differ from the source.", {
      fieldErrors: [{ path: "toLocationId", message: "Same as the source location." }],
    });
  }
}

/** Received minus dispatched, exact: negative = short, positive = over. */
export function varianceQty(dispatched: string, received: string): string {
  return fromQty4(toQty4(received) - toQty4(dispatched));
}

/**
 * Splits what was received over the dispatched batch allocations (given in FEFO order, in ten-thousandths). The
 * first batches fill first; anything beyond what left the source (over-receipt, within tolerance) lands on the last
 * batch. Sum of the result equals `received` exactly.
 */
export function receivedSplit(allocations: readonly bigint[], received: bigint): bigint[] {
  let left = received;
  const out = allocations.map((a) => {
    const r = a < left ? a : left;
    left -= r;
    return r;
  });
  if (left > 0n) {
    if (out.length === 0) throw new RangeError("nothing dispatched to receive against");
    out[out.length - 1] = (out[out.length - 1] ?? 0n) + left;
  }
  return out;
}
