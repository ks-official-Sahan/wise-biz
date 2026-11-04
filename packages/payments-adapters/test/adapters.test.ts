import { describe, expect, it } from "vitest";

import { createMockAdapter, takeCardPayment } from "../src/index.ts";

import type { CardPaymentOptions, IntentState, MockScenario } from "../src/index.ts";

/** A virtual clock: sleeping advances time, so a 90 s timeout runs in microseconds. */
function clock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

function run(
  scenario: MockScenario,
  over: Partial<CardPaymentOptions> = {},
  adapterOver: Parameters<typeof createMockAdapter>[0] extends infer O ? Partial<O> : never = {},
) {
  const c = clock();
  const adapter = createMockAdapter({ scenario, now: c.now, ...adapterOver });
  const states: IntentState[] = [];
  const promise = takeCardPayment({
    adapter,
    amountMinor: 1980,
    currency: "USD",
    reference: "sale-1",
    attempt: 1,
    online: true,
    sleep: c.sleep,
    now: c.now,
    onState: (s) => states.push(s),
    ...over,
  });
  return { adapter, promise, states };
}

describe("card payment runner", () => {
  it("approves and reports non-sensitive card data only", async () => {
    const { promise, states } = run({ kind: "approve", afterMs: 1200 });
    const r = await promise;
    expect(r).toMatchObject({
      ok: true,
      intent: { state: "succeeded", card: { brand: "VISA", last4: "4242" } },
    });
    expect(states[0]).toBe("pending");
    expect(states.at(-1)).toBe("succeeded");
    expect(JSON.stringify(r)).not.toMatch(/\d{13,19}/);
  });

  it("returns a decline with the terminal's message so the tender sheet keeps the cart", async () => {
    const r = await run({ kind: "decline", afterMs: 300 }).promise;
    expect(r).toMatchObject({ ok: false, reason: "declined", message: "Card declined." });
  });

  it("times out, cancels on the terminal and says so", async () => {
    const { promise, adapter } = run({ kind: "hang" }, { timeoutMs: 5000 });
    const r = await promise;
    expect(r).toMatchObject({ ok: false, reason: "timeout", intent: { state: "canceled" } });
    expect([...adapter.intents.values()][0]?.state).toBe("canceled");
  });

  it("is uncertain, not failed, when the terminal cannot confirm a cancel", async () => {
    const r = await run({ kind: "cancel_fails" }, { timeoutMs: 3000 }).promise;
    expect(r).toMatchObject({ ok: false, reason: "uncertain" });
    expect((r as { message: string }).message).toMatch(/Check the terminal/);
  });

  it("cancels when the cashier gives up", async () => {
    let polls = 0;
    const r = await run({ kind: "hang" }, { cancelled: () => ++polls > 2 }).promise;
    expect(r).toMatchObject({ ok: false, reason: "canceled" });
  });

  it("keeps a payment that succeeded at the last moment", async () => {
    // Approves at exactly the deadline poll: cancel then finds it already succeeded.
    const r = await run({ kind: "approve", afterMs: 5000 }, { timeoutMs: 5000, pollMs: 2500 })
      .promise;
    expect(r.ok).toBe(true);
  });

  it("refuses card offline unless the adapter can store and forward", async () => {
    expect(await run({ kind: "approve" }, { online: false }).promise).toMatchObject({
      ok: false,
      reason: "offline_unsupported",
    });
    const r = await run({ kind: "store_and_forward" }, { online: false }).promise;
    expect(r).toMatchObject({ ok: true, intent: { card: { stored: true } } });
  });

  it("refuses a currency the terminal does not take", async () => {
    expect(await run({ kind: "approve" }, { currency: "EUR" }).promise).toMatchObject({
      ok: false,
      reason: "currency",
    });
  });

  it("reports an unreachable terminal and survives a lost poll answer", async () => {
    const c = clock();
    const adapter = createMockAdapter({ scenario: { kind: "approve" }, now: c.now });
    const broken = { ...adapter, createIntent: () => Promise.reject(new Error("down")) };
    const base = {
      amountMinor: 1,
      currency: "USD",
      reference: "r",
      attempt: 1,
      online: true,
      sleep: c.sleep,
      now: c.now,
    };
    expect(await takeCardPayment({ ...base, adapter: broken })).toMatchObject({
      ok: false,
      reason: "uncertain",
    });
    let calls = 0;
    const flaky = {
      ...adapter,
      status: (id: string) =>
        ++calls === 1 ? Promise.reject(new Error("blip")) : adapter.status(id),
    };
    expect(await takeCardPayment({ ...base, adapter: flaky })).toMatchObject({ ok: true });
  });
});

describe("mock adapter", () => {
  it("never charges twice for the same idempotency key, and a new attempt is a new intent", async () => {
    const a = createMockAdapter({ scenario: { kind: "approve" } });
    const input = { amountMinor: 100, currency: "USD", reference: "s", idempotencyKey: "s:1" };
    const one = await a.createIntent(input);
    const again = await a.createIntent(input);
    const second = await a.createIntent({ ...input, idempotencyKey: "s:2" });
    expect(again.id).toBe(one.id);
    expect(second.id).not.toBe(one.id);
    expect(a.intents.size).toBe(2);
  });

  it("refunds a succeeded payment up to its amount only", async () => {
    const a = createMockAdapter({ scenario: { kind: "approve" } });
    const i = await a.createIntent({
      amountMinor: 500,
      currency: "USD",
      reference: "s",
      idempotencyKey: "k",
    });
    await expect(a.refund(i.id, 100, "k0")).rejects.toThrow("nothing to refund");
    await a.status(i.id);
    const r1 = await a.refund(i.id, 200, "k1");
    expect(r1).toMatchObject({ amountMinor: 200 });
    // A retry with the same key returns the same refund and takes nothing more.
    expect(await a.refund(i.id, 200, "k1")).toEqual(r1);
    await expect(a.refund(i.id, 301, "k2")).rejects.toThrow("bad refund amount");
    expect(await a.refund(i.id, 300, "k3")).toMatchObject({ amountMinor: 300 });
    await expect(a.refund(i.id, 1, "k4")).rejects.toThrow("bad refund amount");
    await expect(a.refund(i.id, 0, "k5")).rejects.toThrow();
    await expect(a.status("nope")).rejects.toThrow("unknown intent");
  });

  it("switches scenario on the fly", async () => {
    const a = createMockAdapter({ scenario: { kind: "decline", code: "insufficient_funds" } });
    const i = await a.createIntent({
      amountMinor: 1,
      currency: "USD",
      reference: "s",
      idempotencyKey: "k",
    });
    expect(await a.status(i.id)).toMatchObject({
      state: "failed",
      failure: { code: "insufficient_funds" },
    });
    a.setScenario({ kind: "approve" });
    expect(a.capabilities.offlineStoreAndForward).toBe(false);
    await a.cancel(i.id);
  });
});

describe("defaults", () => {
  it("polls with the real clock when none is injected", async () => {
    const adapter = createMockAdapter({ scenario: { kind: "approve" } });
    const r = await takeCardPayment({
      adapter,
      amountMinor: 1,
      currency: "USD",
      reference: "r",
      attempt: 1,
      online: true,
      pollMs: 1,
    });
    expect(r.ok).toBe(true);
  });
});

describe("review fixes", () => {
  const base = { amountMinor: 100, currency: "USD", reference: "r", attempt: 1, online: true };
  it("rejects a bad amount before touching the terminal", async () => {
    const adapter = createMockAdapter({ scenario: { kind: "approve" } });
    for (const amountMinor of [0, -5, 1.5, Number.NaN]) {
      expect(await takeCardPayment({ ...base, adapter, amountMinor })).toMatchObject({
        ok: false,
        reason: "error",
      });
    }
    expect(adapter.intents.size).toBe(0);
  });

  it("refuses an intent that does not match the request", async () => {
    const adapter = createMockAdapter({ scenario: { kind: "approve" } });
    const wrong = {
      ...adapter,
      createIntent: (i: Parameters<typeof adapter.createIntent>[0]) =>
        adapter.createIntent({ ...i, amountMinor: i.amountMinor + 1 }),
    };
    expect(await takeCardPayment({ ...base, adapter: wrong, pollMs: 1 })).toMatchObject({
      ok: false,
      reason: "uncertain",
    });
  });

  it("is uncertain when the terminal still says pending after a cancel", async () => {
    const adapter = createMockAdapter({ scenario: { kind: "hang" } });
    const stuck = { ...adapter, cancel: () => Promise.resolve() };
    const c = clock();
    const r = await takeCardPayment({
      ...base,
      adapter: stuck,
      timeoutMs: 1000,
      sleep: c.sleep,
      now: c.now,
    });
    expect(r).toMatchObject({ ok: false, reason: "uncertain" });
  });
});
