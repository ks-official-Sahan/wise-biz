import { DomainError } from "@wise-biz/errors";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  applyReceipt,
  assertTransition,
  lineTotalMinor,
  maxReceivable,
  PO_STATUSES,
  shortQty,
  totalMinor,
  TRANSITIONS,
  type PoStatus,
} from "../src/domain/po.ts";
import { fromQty4, normQty, toQty4 } from "../src/domain/qty.ts";

const qty4 = fc.bigInt({ min: 1n, max: 9_999_999n }); // up to 999.9999 units
const bps = fc.integer({ min: 0, max: 2_000 });
const money = fc.integer({ min: 0, max: 5_000_000 });
const fmt = (v: bigint) => fromQty4(v);

describe("quantities", () => {
  it("round-trips canonical decimal strings", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -999_999_999_999n, max: 999_999_999_999n }), (v) => {
        expect(toQty4(fmt(v))).toBe(v);
        expect(normQty(fmt(v))).toBe(fmt(v));
      }),
    );
  });

  it("rejects malformed and over-precise quantities", () => {
    expect(() => toQty4("1.00001")).toThrow(RangeError);
    expect(() => toQty4("abc")).toThrow(RangeError);
    expect(normQty("12.5000")).toBe("12.5");
  });
});

describe("receipts never exceed ordered x (1 + tolerance)", () => {
  it("accepted receipts stay within the cap, refused ones would exceed it", () => {
    fc.assert(
      fc.property(
        qty4,
        bps,
        fc.array(qty4, { minLength: 1, maxLength: 12 }),
        (ordered, tol, receipts) => {
          const cap = maxReceivable(fmt(ordered), tol);
          let received = 0n;
          for (const r of receipts) {
            const line = {
              line: 1,
              orderedQty: fmt(ordered),
              receivedQty: fmt(received),
              unitCostMinor: 1,
            };
            try {
              const plan = applyReceipt([line], [{ line: 1, qty: fmt(r) }], tol);
              received = toQty4(plan.received.get(1) ?? "0");
              expect(received * 10_000n).toBeLessThanOrEqual(ordered * (10_000n + BigInt(tol)));
              expect(received).toBeLessThanOrEqual(cap);
            } catch (e) {
              expect(e).toBeInstanceOf(DomainError);
              // Refused only because it would go past the cap.
              expect(received + r).toBeGreaterThan(cap);
            }
          }
        },
      ),
    );
  });

  it("under-receipt is accepted and closes with the shortfall recorded", () => {
    fc.assert(
      fc.property(qty4, qty4, (ordered, got) => {
        // Receive between 0.0001 and the full order, with no tolerance: never over, sometimes short.
        const incoming = got > ordered ? ordered : got;
        const plan = applyReceipt(
          [{ line: 1, orderedQty: fmt(ordered), receivedQty: "0", unitCostMinor: 1 }],
          [{ line: 1, qty: fmt(incoming) }],
          0,
        );
        expect(plan.status).toBe(incoming === ordered ? "received" : "partially_received");
        expect(shortQty(fmt(ordered), plan.received.get(1) ?? "0")).toBe(fmt(ordered - incoming));
      }),
    );
  });

  it("rejects bad receipts with one field error per problem", () => {
    const lines = [
      { line: 1, orderedQty: "10", receivedQty: "0", unitCostMinor: 100 },
      { line: 2, orderedQty: "5", receivedQty: "0", unitCostMinor: 100 },
    ];
    const cases: [string, { line: number; qty: string }[]][] = [
      ["unknown line", [{ line: 9, qty: "1" }]],
      [
        "duplicate line",
        [
          { line: 1, qty: "1" },
          { line: 1, qty: "1" },
        ],
      ],
      ["zero qty", [{ line: 1, qty: "0" }]],
      ["over tolerance", [{ line: 1, qty: "10.6" }]],
      ["empty", []],
    ];
    for (const [, input] of cases) {
      expect(() => applyReceipt(lines, input, 500)).toThrow(DomainError);
    }
  });

  it("marks the PO received only when every line has reached its ordered quantity", () => {
    const lines = [
      { line: 1, orderedQty: "10", receivedQty: "0", unitCostMinor: 1 },
      { line: 2, orderedQty: "5", receivedQty: "0", unitCostMinor: 1 },
    ];
    expect(applyReceipt(lines, [{ line: 1, qty: "10" }], 0).status).toBe("partially_received");
    expect(
      applyReceipt(
        lines,
        [
          { line: 1, qty: "10" },
          { line: 2, qty: "5" },
        ],
        0,
      ).status,
    ).toBe("received");
  });
});

describe("status transitions follow the machine", () => {
  type Action =
    { kind: "send" } | { kind: "receive"; qty: bigint } | { kind: "close" } | { kind: "cancel" };
  const action = fc.oneof(
    fc.constant<Action>({ kind: "send" }),
    fc.bigInt({ min: 1n, max: 300n }).map((q): Action => ({ kind: "receive", qty: q })),
    fc.constant<Action>({ kind: "close" }),
    fc.constant<Action>({ kind: "cancel" }),
  );

  it("every applied move is an edge of the machine; refused moves leave the state alone", () => {
    fc.assert(
      fc.property(fc.array(action, { maxLength: 25 }), (actions) => {
        let status: PoStatus = "draft";
        let received = 0n;
        const ordered = 100n; // 100 units on one line, 5 % tolerance
        for (const a of actions) {
          const before: PoStatus = status;
          try {
            if (a.kind === "send") {
              assertTransition(status, "sent");
              status = "sent";
            } else if (a.kind === "cancel") {
              assertTransition(status, "cancelled");
              status = "cancelled";
            } else if (a.kind === "close") {
              assertTransition(status, "closed");
              status = "closed";
            } else {
              // Receiving is legal only in a receiving state, and the plan's status must be a legal move.
              if (!["sent", "partially_received", "received"].includes(status)) {
                throw new DomainError("CONFLICT", "not receiving");
              }
              const plan = applyReceipt(
                [
                  {
                    line: 1,
                    orderedQty: fmt(ordered * 10_000n),
                    receivedQty: fmt(received),
                    unitCostMinor: 1,
                  },
                ],
                [{ line: 1, qty: fmt(a.qty * 10_000n) }],
                500,
              );
              assertTransition(status, plan.status);
              status = plan.status;
              received = toQty4(plan.received.get(1) ?? "0") / 10_000n;
            }
          } catch (e) {
            expect(e).toBeInstanceOf(DomainError);
            expect(status).toBe(before);
          }
          if (status !== before) expect(TRANSITIONS[before]).toContain(status);
        }
        // Terminal states absorb: nothing leaves closed or cancelled.
        if (status === "closed" || status === "cancelled") {
          expect(TRANSITIONS[status]).toEqual([]);
        }
      }),
    );
  });

  it("refuses every edge that is not in the table", () => {
    for (const from of PO_STATUSES) {
      for (const to of PO_STATUSES) {
        if (TRANSITIONS[from].includes(to)) {
          expect(() => {
            assertTransition(from, to);
          }).not.toThrow();
        } else {
          expect(() => {
            assertTransition(from, to);
          }).toThrow(DomainError);
        }
      }
    }
  });

  it("only draft and sent can be cancelled; closed needs something received", () => {
    expect(TRANSITIONS.draft).toContain("cancelled");
    expect(TRANSITIONS.sent).toContain("cancelled");
    expect(TRANSITIONS.partially_received).not.toContain("cancelled");
    expect(TRANSITIONS.sent).not.toContain("closed");
    expect(TRANSITIONS.draft).not.toContain("closed");
  });
});

describe("totals are exact minor-unit sums", () => {
  it("PO total equals the sum of line totals, each rounded half up once, in any order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ qty: qty4, cost: money }), { minLength: 1, maxLength: 20 }),
        (lines) => {
          const asLines = lines.map((l) => ({ qty: fmt(l.qty), unitCostMinor: l.cost }));
          const reference = lines.reduce(
            (acc, l) => acc + (l.qty * BigInt(l.cost) + 5_000n) / 10_000n,
            0n,
          );
          const total = totalMinor(asLines, "USD");
          expect(BigInt(total)).toBe(reference);
          const reversed = [...asLines].reverse();
          expect(totalMinor(reversed, "USD")).toBe(total);
          // No drift: the total is within half a minor unit per line of the exact value.
          const exact = lines.reduce((acc, l) => acc + l.qty * BigInt(l.cost), 0n);
          const diff = BigInt(total) * 10_000n - exact;
          const bound = BigInt(lines.length) * 5_000n;
          expect(diff <= bound && -diff <= bound).toBe(true);
        },
      ),
    );
  });

  it("a line rounds half up: 1.5 units at 3 minor is 4.5 -> 5", () => {
    expect(lineTotalMinor("1.5", 3, "USD")).toBe(5);
    expect(lineTotalMinor("0.0001", 1, "JPY")).toBe(0);
    expect(totalMinor([], "USD")).toBe(0);
  });

  it("is zero-decimal aware (JPY has no minor fraction)", () => {
    expect(totalMinor([{ qty: "2", unitCostMinor: 150 }], "JPY")).toBe(300);
  });
});
