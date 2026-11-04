import { createMockAdapter } from "@wise-biz/payments-adapters";
import { describe, expect, it } from "vitest";

import { createTenderSession } from "../src/features/tender/model/session.ts";

import type { CommittedSale } from "../src/features/tender/model/commit.ts";
import type { TenderState } from "../src/features/tender/model/session.ts";
import type { TenderEntry } from "../src/features/tender/model/tender.ts";
import type { MockScenario } from "@wise-biz/payments-adapters";

const sale: CommittedSale = { saleId: "s1", saleNo: 1, completedAt: 0, shiftId: "sh" };

function setup(
  scenario: MockScenario | undefined,
  over: {
    online?: boolean;
    payable?: number;
    commitFails?: boolean;
    printFails?: boolean;
    noPrinter?: boolean;
  } = {},
) {
  let t = 1_000;
  const committed: TenderEntry[][] = [];
  const printed: number[] = [];
  const states: TenderState[] = [];
  let n = 0;
  const clock = {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
  const session = createTenderSession({
    payableMinor: over.payable ?? 1985,
    currency: "USD",
    saleRef: "sale-1",
    adapter: scenario === undefined ? undefined : createMockAdapter({ scenario, now: clock.now }),
    online: () => over.online ?? true,
    newId: () => `t${String(++n)}`,
    commit: (tenders) => {
      if (over.commitFails === true)
        return Promise.reject(new Error("The sale could not be saved."));
      committed.push([...tenders]);
      return Promise.resolve(sale);
    },
    print:
      over.noPrinter === true
        ? undefined
        : (_s, ts) => {
            if (over.printFails === true) return Promise.reject(new Error("printer off"));
            printed.push(ts.length);
            return Promise.resolve();
          },
    onChange: (s) => states.push(s),
    ...clock,
  });
  return { session, committed, printed, states };
}

describe("cash", () => {
  it("finishes with change and prints", async () => {
    const { session, committed, printed } = setup(undefined);
    await session.addCash(2000);
    const s = session.state();
    expect(s).toMatchObject({
      phase: "done",
      changeMinor: 15,
      remainingMinor: 0,
      printed: "ok",
      sale,
    });
    expect(committed[0]).toEqual([
      { id: "t1", kind: "cash", amountMinor: 1985, receivedMinor: 2000, changeMinor: 15 },
    ]);
    expect(printed).toEqual([1]);
  });

  it("takes partial cash, shows what is left, and can take it back", async () => {
    const { session } = setup(undefined);
    await session.addCash(1000);
    expect(session.state()).toMatchObject({
      phase: "tendering",
      remainingMinor: 985,
      changeMinor: 0,
    });
    session.removeTender("t1");
    expect(session.state().remainingMinor).toBe(1985);
    await session.addCash(0);
    expect(session.state().tenders).toHaveLength(0);
  });

  it("does nothing after the sale is done", async () => {
    const { session, committed } = setup(undefined);
    await session.addCash(1985);
    await session.addCash(5000);
    session.removeTender("t1");
    expect(committed).toHaveLength(1);
    expect(session.state().tenders).toHaveLength(1);
  });
});

describe("card and split", () => {
  it("pays part by card and the rest in cash; the card tender carries only brand, last4 and auth", async () => {
    const { session, committed } = setup({ kind: "approve", afterMs: 500 });
    await session.takeCard(1000);
    expect(session.state()).toMatchObject({ phase: "tendering", remainingMinor: 985 });
    await session.addCash(1000);
    const [tenders] = committed;
    expect(tenders?.map((t) => t.kind)).toEqual(["card", "cash"]);
    expect(tenders?.[0]?.card).toMatchObject({ provider: "terminal", last4: "4242" });
    expect(JSON.stringify(tenders)).not.toMatch(/\d{13,19}/);
    expect(session.state().changeMinor).toBe(15);
  });

  it("pays everything by card when no amount is given", async () => {
    const { session, committed } = setup({ kind: "approve" });
    await session.takeCard();
    expect(session.state().phase).toBe("done");
    expect(committed[0]?.[0]?.amountMinor).toBe(1985);
  });

  it("a decline returns to the sheet with the cart and earlier tenders intact", async () => {
    const { session, committed } = setup({ kind: "decline" });
    await session.addCash(500);
    await session.takeCard();
    expect(session.state()).toMatchObject({
      phase: "tendering",
      remainingMinor: 1485,
      message: { text: "Card declined." },
    });
    expect(session.state().tenders).toHaveLength(1);
    expect(committed).toHaveLength(0);
  });

  it("an uncertain card result is shown as an error and nothing is added", async () => {
    const { session } = setup({ kind: "cancel_fails" });
    session.cancelCard();
    await session.takeCard();
    expect(session.state()).toMatchObject({ phase: "tendering", message: { tone: "danger" } });
    expect(session.state().tenders).toHaveLength(0);
  });

  it("cannot take a card without an adapter, offline without store-and-forward, or for nothing", async () => {
    const none = setup(undefined);
    await none.session.takeCard();
    expect(none.session.state().phase).toBe("tendering");
    const off = setup({ kind: "approve" }, { online: false });
    await off.session.takeCard();
    expect(off.session.state().message?.text).toMatch(/connection/);
    const zero = setup({ kind: "approve" });
    await zero.session.addCash(1985);
    await zero.session.takeCard();
    expect(zero.session.state().phase).toBe("done");
  });

  it("does not let a card tender be removed", async () => {
    const { session } = setup({ kind: "approve" });
    await session.takeCard(500);
    session.removeTender("t1");
    expect(session.state().tenders).toHaveLength(1);
  });
});

describe("saving and printing", () => {
  it("a failed save leaves the tenders so the cashier can retry", async () => {
    const { session } = setup(undefined, { commitFails: true });
    await session.addCash(2000);
    expect(session.state()).toMatchObject({
      phase: "tendering",
      message: { text: "The sale could not be saved." },
    });
    expect(session.state().tenders).toHaveLength(1);
  });

  it("a failed print keeps the sale and allows a reprint", async () => {
    const failing = setup(undefined, { printFails: true });
    await failing.session.addCash(2000);
    expect(failing.session.state()).toMatchObject({ phase: "done", printed: "failed", sale });
    await failing.session.reprint();
    expect(failing.session.state().printed).toBe("failed");
    const ok = setup(undefined);
    await ok.session.reprint();
    await ok.session.addCash(2000);
    await ok.session.reprint();
    expect(ok.printed).toEqual([1, 1]);
  });

  it("says no printer when none is set up", async () => {
    const { session } = setup(undefined, { noPrinter: true });
    await session.addCash(2000);
    expect(session.state()).toMatchObject({ phase: "done", printed: "none" });
    await session.reprint();
    expect(session.paid()).toBe(1985);
  });
});

describe("review fixes", () => {
  it("a failed save after full payment can be retried with the same sale id", async () => {
    const ids: string[] = [];
    let fail = true;
    const session = createTenderSession({
      payableMinor: 500,
      currency: "USD",
      saleRef: "sale-xyz",
      adapter: createMockAdapter({ scenario: { kind: "approve" } }),
      online: () => true,
      newId: () => "t",
      commit: (_t, id) => {
        ids.push(id);
        return fail ? Promise.reject(new Error("disk full")) : Promise.resolve(sale);
      },
      print: undefined,
      onChange: () => undefined,
      sleep: () => Promise.resolve(),
    });
    await session.takeCard();
    expect(session.state()).toMatchObject({
      phase: "tendering",
      needsSave: true,
      remainingMinor: 0,
    });
    await session.addCash(100);
    expect(session.state().tenders).toHaveLength(1);
    fail = false;
    await session.retrySave();
    expect(session.state()).toMatchObject({ phase: "done", sale });
    expect(ids).toEqual(["sale-xyz", "sale-xyz"]);
    await session.retrySave();
    expect(ids).toHaveLength(2);
  });

  it("blocks another card attempt after an uncertain result until the cashier confirms", async () => {
    const { session } = setup({ kind: "cancel_fails" });
    await session.takeCard();
    expect(session.state().cardBlocked).toBe(true);
    await session.takeCard();
    expect(session.state().phase).toBe("tendering");
    session.clearCardBlock();
    expect(session.state().cardBlocked).toBeUndefined();
  });

  it("maps a throwing terminal runner to an uncertain, blocked state", async () => {
    const adapter = createMockAdapter({ scenario: { kind: "approve" } });
    const boom = { ...adapter, capabilities: undefined as never };
    const session = createTenderSession({
      payableMinor: 500,
      currency: "USD",
      saleRef: "s",
      adapter: boom,
      online: () => true,
      newId: () => "t",
      commit: () => Promise.resolve(sale),
      print: undefined,
      onChange: () => undefined,
    });
    await session.takeCard();
    expect(session.state()).toMatchObject({
      phase: "tendering",
      cardBlocked: true,
      message: { tone: "danger" },
    });
  });
});
