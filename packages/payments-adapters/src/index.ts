/**
 * Card payments through a semi-integrated terminal: the app sends an amount, the terminal handles the card, and the
 * result comes back as a state plus non-sensitive receipt data. Card numbers never reach this code (PCI scope stays with
 * the terminal). One adapter per provider implements `PaymentAdapter`; core code only sees this file.
 */

export type IntentState = "created" | "pending" | "succeeded" | "failed" | "canceled";

export interface CardReceiptData {
  readonly brand: string;
  readonly last4: string;
  readonly authCode: string;
  /** True when the terminal approved offline and will settle later (store and forward). */
  readonly stored?: boolean | undefined;
}

export interface Intent {
  readonly id: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** The sale id: the same reference never charges twice. */
  readonly reference: string;
  readonly state: IntentState;
  readonly failure?: { readonly code: string; readonly message: string } | undefined;
  readonly card?: CardReceiptData | undefined;
}

export interface AdapterCapabilities {
  readonly cardPresent: boolean;
  readonly online: boolean;
  readonly qr: boolean;
  readonly refunds: boolean;
  readonly partialRefunds: boolean;
  readonly offlineStoreAndForward: boolean;
  readonly currencies: readonly string[];
}

export interface CreateIntent {
  readonly amountMinor: number;
  readonly currency: string;
  readonly reference: string;
  /** Same key, same intent: a retry after a lost answer must not start a second charge. */
  readonly idempotencyKey: string;
}

export interface PaymentAdapter {
  readonly capabilities: AdapterCapabilities;
  /** Starts the payment on the terminal; resolves with a `pending` intent. */
  readonly createIntent: (input: CreateIntent) => Promise<Intent>;
  /** Current state of an intent (polling a terminal; webhooks are the server's job). */
  readonly status: (intentId: string) => Promise<Intent>;
  /** Cancels a pending intent on the terminal. Resolves when the terminal confirmed it is no longer charging. */
  readonly cancel: (intentId: string) => Promise<void>;
  readonly refund: (
    intentId: string,
    amountMinor: number,
    idempotencyKey: string,
  ) => Promise<{ readonly refundId: string; readonly amountMinor: number }>;
}

export type CardOutcome =
  | { readonly ok: true; readonly intent: Intent }
  | {
      readonly ok: false;
      readonly reason:
        | "declined"
        | "timeout"
        | "canceled"
        | "offline_unsupported"
        | "currency"
        | "error"
        | "uncertain";
      readonly intent?: Intent;
      readonly message: string;
    };

export interface CardPaymentOptions {
  readonly adapter: PaymentAdapter;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reference: string;
  /** Distinguishes a deliberate second attempt after a decline from a retry of the same one. */
  readonly attempt: number;
  readonly online: boolean;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Live status for the tender sheet. */
  readonly onState?: (state: IntentState) => void;
  /** The cashier pressed Cancel. */
  readonly cancelled?: () => boolean;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs one card payment to a final answer: checks the adapter can take it (offline, currency), starts it, polls the
 * terminal, and cancels on timeout or when the cashier gives up. If the terminal cannot confirm a cancel the outcome is
 * `uncertain`: the cashier must check the terminal before trying again, so a customer is never charged twice.
 */
export async function takeCardPayment(o: CardPaymentOptions): Promise<CardOutcome> {
  const { adapter } = o;
  const sleep = o.sleep ?? realSleep;
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 500;
  const timeoutMs = o.timeoutMs ?? 90_000;
  if (!Number.isSafeInteger(o.amountMinor) || o.amountMinor <= 0) {
    return { ok: false, reason: "error", message: "The amount to charge is not valid." };
  }
  if (!adapter.capabilities.currencies.includes(o.currency)) {
    return { ok: false, reason: "currency", message: `This terminal cannot take ${o.currency}.` };
  }
  if (!o.online && !adapter.capabilities.offlineStoreAndForward) {
    return {
      ok: false,
      reason: "offline_unsupported",
      message: "Card payments need a connection on this terminal.",
    };
  }
  let intent: Intent;
  try {
    intent = await adapter.createIntent({
      amountMinor: o.amountMinor,
      currency: o.currency,
      reference: o.reference,
      idempotencyKey: `${o.reference}:${String(o.attempt)}`,
    });
  } catch {
    // The terminal may have started charging and only the answer was lost: never invite a second attempt.
    return {
      ok: false,
      reason: "uncertain",
      message: "The card terminal did not answer. Check the terminal before trying again.",
    };
  }
  if (
    intent.amountMinor !== o.amountMinor ||
    intent.currency !== o.currency ||
    intent.reference !== o.reference
  ) {
    return {
      ok: false,
      reason: "error",
      intent,
      message: "The terminal returned a different payment. Check it before trying again.",
    };
  }
  o.onState?.(intent.state);
  const deadline = now() + timeoutMs;

  const giveUp = async (reason: "timeout" | "canceled", message: string): Promise<CardOutcome> => {
    try {
      await adapter.cancel(intent.id);
      const final = await adapter.status(intent.id);
      // The customer may have tapped at the last moment.
      if (final.state === "succeeded") return { ok: true, intent: final };
      if (final.state === "pending" || final.state === "created") {
        return {
          ok: false,
          reason: "uncertain",
          intent: final,
          message:
            "Could not confirm the card was not charged. Check the terminal before trying again.",
        };
      }
      o.onState?.(final.state);
      return { ok: false, reason, intent: final, message };
    } catch {
      return {
        ok: false,
        reason: "uncertain",
        intent,
        message:
          "Could not confirm the card was not charged. Check the terminal before trying again.",
      };
    }
  };

  for (;;) {
    if (o.cancelled?.() === true) return giveUp("canceled", "Card payment canceled.");
    if (now() >= deadline) return giveUp("timeout", "The card terminal took too long.");
    await sleep(pollMs);
    try {
      intent = await adapter.status(intent.id);
    } catch {
      // A lost poll answer is not a failed payment: keep asking until the deadline.
      continue;
    }
    o.onState?.(intent.state);
    if (intent.state === "succeeded") return { ok: true, intent };
    if (intent.state === "failed") {
      return {
        ok: false,
        reason: "declined",
        intent,
        message: intent.failure?.message ?? "Card declined.",
      };
    }
    if (intent.state === "canceled")
      return { ok: false, reason: "canceled", intent, message: "Card payment canceled." };
  }
}

export type MockScenario =
  | { readonly kind: "approve"; readonly afterMs?: number }
  | { readonly kind: "decline"; readonly code?: string; readonly afterMs?: number }
  /** The terminal never answers (cable pulled). */
  | { readonly kind: "hang" }
  /** Approved offline: needs `offlineStoreAndForward`. */
  | { readonly kind: "store_and_forward"; readonly afterMs?: number }
  /** Cancel fails: the terminal is unreachable after the charge started. */
  | { readonly kind: "cancel_fails" };

export interface MockOptions {
  readonly scenario: MockScenario;
  readonly now?: () => number;
  readonly currencies?: readonly string[];
  readonly offlineStoreAndForward?: boolean;
}

/** A terminal on the desk that behaves exactly as told: for tests, demos and development without hardware. */
export function createMockAdapter(options: MockOptions): PaymentAdapter & {
  readonly intents: Map<string, Intent>;
  setScenario: (s: MockScenario) => void;
} {
  const now = options.now ?? Date.now;
  let scenario = options.scenario;
  let n = 0;
  const intents = new Map<string, Intent>();
  const started = new Map<string, number>();
  const byKey = new Map<string, string>();
  const canceled = new Set<string>();
  const refunded = new Map<string, number>();
  const refunds = new Map<string, { refundId: string; amountMinor: number }>();

  const settle = (id: string): Intent => {
    const cur = intents.get(id);
    if (cur === undefined) throw new Error("unknown intent");
    if (cur.state !== "pending" || canceled.has(id)) return cur;
    const age = now() - (started.get(id) ?? 0);
    let next: Intent = cur;
    if (scenario.kind === "approve" && age >= (scenario.afterMs ?? 0)) {
      next = {
        ...cur,
        state: "succeeded",
        card: { brand: "VISA", last4: "4242", authCode: `A${String(id.length)}${id.slice(-3)}` },
      };
    } else if (scenario.kind === "store_and_forward" && age >= (scenario.afterMs ?? 0)) {
      next = {
        ...cur,
        state: "succeeded",
        card: { brand: "VISA", last4: "4242", authCode: "OFFLINE", stored: true },
      };
    } else if (scenario.kind === "decline" && age >= (scenario.afterMs ?? 0)) {
      next = {
        ...cur,
        state: "failed",
        failure: { code: scenario.code ?? "card_declined", message: "Card declined." },
      };
    }
    intents.set(id, next);
    return next;
  };

  return {
    intents,
    setScenario: (s) => {
      scenario = s;
    },
    capabilities: {
      cardPresent: true,
      online: true,
      qr: false,
      refunds: true,
      partialRefunds: true,
      offlineStoreAndForward:
        options.offlineStoreAndForward ?? scenario.kind === "store_and_forward",
      currencies: options.currencies ?? ["USD", "LKR"],
    },
    createIntent: (input) => {
      const existing = byKey.get(input.idempotencyKey);
      const prior = existing === undefined ? undefined : intents.get(existing);
      if (prior !== undefined) return Promise.resolve(prior);
      const id = `mock_${String(++n)}`;
      const intent: Intent = {
        id,
        amountMinor: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        state: "pending",
      };
      intents.set(id, intent);
      started.set(id, now());
      byKey.set(input.idempotencyKey, id);
      return Promise.resolve(intent);
    },
    status: (id) => {
      try {
        return Promise.resolve(settle(id));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    cancel: (id) => {
      if (scenario.kind === "cancel_fails")
        return Promise.reject(new Error("terminal unreachable"));
      const cur = intents.get(id);
      if (cur?.state === "pending") {
        canceled.add(id);
        intents.set(id, { ...cur, state: "canceled" });
      }
      return Promise.resolve();
    },
    refund: (id, amountMinor, idempotencyKey) => {
      const done = refunds.get(`${id}:${idempotencyKey}`);
      if (done !== undefined) return Promise.resolve(done);
      const cur = intents.get(id);
      if (cur?.state !== "succeeded") return Promise.reject(new Error("nothing to refund"));
      const so_far = refunded.get(id) ?? 0;
      if (
        !Number.isSafeInteger(amountMinor) ||
        amountMinor <= 0 ||
        so_far + amountMinor > cur.amountMinor
      ) {
        return Promise.reject(new Error("bad refund amount"));
      }
      refunded.set(id, so_far + amountMinor);
      const r = { refundId: `${id}_r${String(++n)}`, amountMinor };
      refunds.set(`${id}:${idempotencyKey}`, r);
      return Promise.resolve(r);
    },
  };
}
