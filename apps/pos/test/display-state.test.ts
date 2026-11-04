import { describe, expect, it } from "vitest";

import { displayStateFor } from "../src/features/devices/model/display-state.ts";

import type { SellLine, SellTotals } from "../src/features/sell/ui/types.ts";
import type { TenderState } from "../src/features/tender/model/session.ts";

const line = (name: string, qty: number, total: number): SellLine => ({
  id: name,
  name,
  detail: "",
  qty,
  lineTotalMinor: total,
});
const totals: SellTotals = {
  subtotalMinor: 1000,
  discountMinor: 0,
  taxMinor: 100,
  totalMinor: 1100,
  itemCount: 2,
  currency: "USD",
};

describe("customer display state", () => {
  it("shows the welcome screen for an empty cart", () => {
    expect(displayStateFor({ lines: [], totals })).toBeNull();
  });

  it("mirrors the cart and total while ringing up", () => {
    expect(displayStateFor({ lines: [line("Tea", 2, 1006)], totals })).toEqual({
      lines: [{ name: "Tea", qty: "2", totalMinor: 1006 }],
      totalMinor: 1100,
      changeMinor: 0,
      currency: "USD",
    });
  });

  it("shows the change and a thank-you once paid, even after the cart is cleared", () => {
    const done = { phase: "done", changeMinor: 94 } as unknown as TenderState;
    expect(displayStateFor({ lines: [line("Tea", 1, 503)], totals, tender: done })).toMatchObject({
      changeMinor: 94,
      message: "Thank you",
    });
    expect(displayStateFor({ lines: [], totals, tender: done })).toMatchObject({
      message: "Thank you",
    });
    const paying = { phase: "tendering", changeMinor: 0 } as unknown as TenderState;
    expect(
      displayStateFor({ lines: [line("Tea", 1, 503)], totals, tender: paying })?.message,
    ).toBeUndefined();
  });

  it("keeps text and amounts inside what the shell accepts", () => {
    const s = displayStateFor({ lines: [line("x".repeat(300), 1.5, -5)], totals });
    expect(s?.lines[0]?.name).toHaveLength(120);
    expect(s?.lines[0]).toMatchObject({ qty: "1.5", totalMinor: 0 });
  });
});
