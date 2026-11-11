import { DomainError } from "@wise-biz/errors";
import { money, multiply } from "@wise-biz/money";

/**
 * Stock count state machine. Pure: no I/O, no clock. Every status change goes through `assertCountTransition`.
 * draft -> open -> review -> approved; review -> open is a recount request; draft, open and review can be cancelled.
 */
export const COUNT_STATUSES = ["draft", "open", "review", "approved", "cancelled"] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

export const COUNT_TRANSITIONS: Readonly<Record<CountStatus, readonly CountStatus[]>> = {
  draft: ["open", "cancelled"],
  open: ["review", "cancelled"],
  review: ["open", "approved", "cancelled"],
  approved: [],
  cancelled: [],
};

export function assertCountTransition(from: CountStatus, to: CountStatus): void {
  if (!COUNT_TRANSITIONS[from].includes(to)) {
    throw new DomainError("CONFLICT", `A count cannot go from ${from} to ${to}.`);
  }
}

/** Upper bound of lines per count: a full count of a larger location is split into cycle counts. */
export const MAX_COUNT_LINES = 5000;

export type CountMode = "frozen" | "live";

/**
 * What the line is measured against. Live: the stock at the close cut (movements during the count are part of the
 * expectation). Frozen: the snapshot (valid only when nothing moved, see assertApprovable).
 */
export function expectedAtClose(mode: CountMode, snapshot4: bigint, close4: bigint): bigint {
  return mode === "live" ? close4 : snapshot4;
}

/** Physical minus expected, exact. Positive = over, negative = short. */
export function varianceOf(counted4: bigint, expected4: bigint): bigint {
  return counted4 - expected4;
}

/**
 * Value of a variance at a unit cost, half-up on the minor unit (through @wise-biz/money). An unknown cost is `null`,
 * never 0: a line with no known cost must not look valued.
 */
export function valueMinor(
  variance4: bigint,
  unitCostMinor: number | null,
  currency: string,
): number | null {
  if (unitCostMinor === null) return null;
  return multiply(
    money(unitCostMinor, currency),
    { num: Number(variance4), den: 10_000 },
    "half-up",
  ).minor;
}

export interface ApprovalLine {
  readonly counted4: bigint | null;
  readonly snapshot4: bigint;
  readonly close4: bigint | null;
}

/**
 * Approval gate. Every line must be counted. A frozen count is approvable only if no stock moved between snapshot and
 * close: a frozen expectation that ignores movements would book the sales as shrinkage.
 */
export function assertApprovable(mode: CountMode, lines: readonly ApprovalLine[]): void {
  const uncounted = lines.filter((l) => l.counted4 === null).length;
  if (uncounted > 0) {
    throw new DomainError("CONFLICT", `${String(uncounted)} line(s) are not counted yet.`);
  }
  if (lines.some((l) => l.close4 === null)) {
    throw new DomainError("CONFLICT", "Close the count before approving it.");
  }
  if (mode === "frozen" && lines.some((l) => l.close4 !== l.snapshot4)) {
    throw new DomainError("CONFLICT", "Stock moved during a frozen count. Recount, or count live.");
  }
}
