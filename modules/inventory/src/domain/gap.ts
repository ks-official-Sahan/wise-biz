import { DomainError } from "@wise-biz/errors";

/**
 * Stock-gap case rules. Pure: no I/O, no clock. Every status change goes through `assertGapTransition`.
 * open -> investigating -> resolved; open -> resolved is allowed (a case can be closed without an assignee).
 */
export const GAP_STATUSES = ["open", "investigating", "resolved"] as const;
export type GapStatus = (typeof GAP_STATUSES)[number];

export const RESOLUTION_CODES = [
  "theft",
  "damage",
  "data_error",
  "misplaced_found",
  "supplier_short",
] as const;
export type ResolutionCode = (typeof RESOLUTION_CODES)[number];

export const GAP_TRANSITIONS: Readonly<Record<GapStatus, readonly GapStatus[]>> = {
  open: ["investigating", "resolved"],
  investigating: ["resolved"],
  resolved: [],
};

export function assertGapTransition(from: GapStatus, to: GapStatus): void {
  if (!GAP_TRANSITIONS[from].includes(to)) {
    throw new DomainError("CONFLICT", `A gap case cannot go from ${from} to ${to}.`);
  }
}

export interface GapThresholds {
  /** Absolute variance in ten-thousandths (qty4). A line is a case when |variance| is strictly over it. */
  readonly minQty4?: bigint | undefined;
  /** Absolute value in minor units. A line is a case when |value| is strictly over it, or its value is unknown. */
  readonly minValueMinor?: number | undefined;
}

/**
 * Whether a variance line becomes a case. The two thresholds are alternatives (either one selects the line). A line
 * with no known value (null) is never "small": under a value threshold it is a case, so it cannot hide in a report.
 * A zero variance is never a case.
 */
export function isGapCase(variance4: bigint, valueMinor: number | null, t: GapThresholds): boolean {
  if (variance4 === 0n) return false;
  const abs = variance4 < 0n ? -variance4 : variance4;
  if (t.minQty4 !== undefined && abs > t.minQty4) return true;
  if (t.minValueMinor !== undefined) {
    if (valueMinor === null) return true;
    if (Math.abs(valueMinor) > t.minValueMinor) return true;
  }
  return false;
}

/**
 * A misplaced-found resolution posts the found quantity at the location where it was found, so it is bounded by the
 * shortage it explains. Other codes take no quantity.
 */
export function assertResolution(
  code: ResolutionCode,
  variance4: bigint,
  found4: bigint | null,
): void {
  if (code !== "misplaced_found") {
    if (found4 !== null) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Only a misplaced-found resolution takes a quantity.",
      );
    }
    return;
  }
  if (found4 === null || found4 <= 0n) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "A misplaced-found resolution needs a positive quantity.",
    );
  }
  if (variance4 >= 0n) {
    throw new DomainError("CONFLICT", "Only a shortage can be misplaced stock.");
  }
  if (found4 > -variance4) {
    throw new DomainError("VALIDATION_FAILED", "The found quantity is more than the shortage.");
  }
}
