import { DomainError } from "@wise-biz/errors";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { fromQty4, toQty4 } from "../src/domain/qty.ts";
import {
  assertDistinctLocations,
  assertTransferTransition,
  receivedSplit,
  TRANSFER_STATUSES,
  TRANSFER_TRANSITIONS,
  varianceQty,
  type TransferStatus,
} from "../src/domain/transfer.ts";

const qty4 = fc.bigInt({ min: 0n, max: 9_999_999n });

describe("transfer state machine", () => {
  const allowed = new Set([
    "requested>dispatched",
    "requested>cancelled",
    "dispatched>received",
    "received>closed",
  ]);

  it("allows exactly the documented transitions, nothing else", () => {
    for (const from of TRANSFER_STATUSES) {
      for (const to of TRANSFER_STATUSES) {
        const ok = allowed.has(`${from}>${to}`);
        if (ok) {
          expect(() => {
            assertTransferTransition(from, to);
          }).not.toThrow();
        } else {
          expect(() => {
            assertTransferTransition(from, to);
          }).toThrow(DomainError);
        }
      }
    }
  });

  it("random walks never leave the machine and never reach an illegal state", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...TRANSFER_STATUSES), { minLength: 1, maxLength: 20 }),
        (targets) => {
          let at: TransferStatus = "requested";
          for (const to of targets) {
            if (TRANSFER_TRANSITIONS[at].includes(to)) {
              at = to;
            } else {
              expect(() => {
                assertTransferTransition(at, to);
              }).toThrow(DomainError);
            }
          }
          // Closed and cancelled are terminal.
          if (at === "closed" || at === "cancelled") {
            expect(TRANSFER_TRANSITIONS[at]).toHaveLength(0);
          }
        },
      ),
    );
  });

  it("source and destination must differ", () => {
    expect(() => {
      assertDistinctLocations("a", "a");
    }).toThrow(DomainError);
    expect(() => {
      assertDistinctLocations("a", "b");
    }).not.toThrow();
  });
});

describe("variance is exact integer arithmetic", () => {
  it("is received minus dispatched: negative short, positive over", () => {
    expect(varianceQty("10", "8")).toBe("-2");
    expect(varianceQty("10", "12.5")).toBe("2.5");
    expect(varianceQty("0.1", "0.3")).toBe("0.2");
  });

  it("equals the exact difference for any pair of 4-place quantities", () => {
    fc.assert(
      fc.property(qty4, qty4, (d, r) => {
        expect(toQty4(varianceQty(fromQty4(d), fromQty4(r)))).toBe(r - d);
      }),
    );
  });
});

describe("receipts split over the dispatched batches, first expiry first", () => {
  it("conserves the received quantity and never gives a batch more than it had unless over-received", () => {
    fc.assert(
      fc.property(
        fc.array(
          qty4.filter((v) => v > 0n),
          { minLength: 1, maxLength: 6 },
        ),
        qty4,
        (allocs, received) => {
          const total = allocs.reduce((a, b) => a + b, 0n);
          if (received > total * 2n) return; // beyond any tolerance the caller allows
          const split = receivedSplit(allocs, received);
          expect(split).toHaveLength(allocs.length);
          expect(split.reduce((a, b) => a + b, 0n)).toBe(received);
          split.forEach((r, i) => {
            expect(r).toBeGreaterThanOrEqual(0n);
            if (received <= total) expect(r).toBeLessThanOrEqual(allocs[i] ?? 0n);
          });
        },
      ),
    );
  });

  it("fills the first batch before the second, and puts over-receipt on the last batch", () => {
    expect(receivedSplit([50_000n, 30_000n], 60_000n)).toEqual([50_000n, 10_000n]);
    expect(receivedSplit([50_000n, 30_000n], 90_000n)).toEqual([50_000n, 40_000n]);
    expect(receivedSplit([50_000n, 30_000n], 85_000n)).toEqual([50_000n, 35_000n]);
  });
});
