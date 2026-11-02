import { takeCardPayment } from "@wise-biz/payments-adapters";

import { cashTender, paid, remaining } from "./tender.ts";

import type { CommittedSale } from "./commit.ts";
import type { TenderEntry } from "./tender.ts";
import type { CardOutcome, IntentState, PaymentAdapter } from "@wise-biz/payments-adapters";

export type TenderPhase = "tendering" | "card" | "committing" | "done";

export interface TenderState {
  readonly phase: TenderPhase;
  readonly tenders: readonly TenderEntry[];
  readonly remainingMinor: number;
  readonly changeMinor: number;
  /** Live terminal state while a card payment runs. */
  readonly cardState?: IntentState;
  /** What to tell the cashier, or nothing. */
  readonly message?: { readonly tone: "danger" | "info"; readonly text: string };
  readonly sale?: CommittedSale;
  /** The sale is saved but the receipt did not print (or no printer is set up). */
  readonly printed?: "ok" | "failed" | "none";
  /** Paid in full but the save failed: the cashier can retry saving; nothing else is possible. */
  readonly needsSave?: boolean;
  /** A card result is unknown: no new card attempt until the cashier confirms the terminal was checked. */
  readonly cardBlocked?: boolean;
}

export interface TenderDeps {
  readonly payableMinor: number;
  readonly currency: string;
  /** The sale id: used for the card reference and for the committed sale, so both are one thing. */
  readonly saleRef: string;
  readonly adapter: PaymentAdapter | undefined;
  readonly online: () => boolean;
  readonly newId: () => string;
  /** Commits the sale locally with these tenders (one transaction). */
  readonly commit: (tenders: readonly TenderEntry[], saleId: string) => Promise<CommittedSale>;
  /** Prints the receipt of a committed sale; rejects when the printer fails. Undefined: no printer set up. */
  readonly print:
    ((sale: CommittedSale, tenders: readonly TenderEntry[]) => Promise<void>) | undefined;
  readonly onChange: (state: TenderState) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * One payment, from the tender sheet to a finished sale. Cash and card tenders add up until nothing is owed; the sale
 * commits locally (one transaction) the moment it is fully paid; printing starts right after and can fail without
 * undoing the sale. A card decline or timeout leaves the cart and the other tenders exactly as they were.
 */
export function createTenderSession(d: TenderDeps) {
  let tenders: TenderEntry[] = [];
  let phase: TenderPhase = "tendering";
  let cardState: IntentState | undefined;
  let message: TenderState["message"];
  let sale: CommittedSale | undefined;
  let printed: TenderState["printed"];
  let attempt = 0;
  let cancelRequested = false;
  let cardBlocked = false;

  const snapshot = (): TenderState => ({
    phase,
    tenders,
    remainingMinor: remaining(d.payableMinor, tenders),
    changeMinor: tenders.reduce((n, t) => n + (t.changeMinor ?? 0), 0),
    ...(cardState === undefined ? {} : { cardState }),
    ...(message === undefined ? {} : { message }),
    ...(sale === undefined ? {} : { sale }),
    ...(printed === undefined ? {} : { printed }),
    ...(phase === "tendering" && tenders.length > 0 && remaining(d.payableMinor, tenders) === 0
      ? { needsSave: true }
      : {}),
    ...(cardBlocked ? { cardBlocked } : {}),
  });
  const emit = () => {
    d.onChange(snapshot());
  };

  async function finish(): Promise<void> {
    phase = "committing";
    message = undefined;
    emit();
    try {
      sale = await d.commit(tenders, d.saleRef);
    } catch (e) {
      phase = "tendering";
      message = {
        tone: "danger",
        text: e instanceof Error ? e.message : "The sale could not be saved.",
      };
      emit();
      return;
    }
    phase = "done";
    if (d.print === undefined) {
      printed = "none";
      emit();
      return;
    }
    emit();
    try {
      await d.print(sale, tenders);
      printed = "ok";
    } catch {
      printed = "failed";
    }
    emit();
  }

  return {
    state: snapshot,

    /** Cash handed over now. Less than what is owed makes a partial tender; more gives change and finishes the sale. */
    async addCash(receivedMinor: number): Promise<void> {
      if (phase !== "tendering") return;
      const left = remaining(d.payableMinor, tenders);
      const { amountMinor, changeMinor } = cashTender(left, receivedMinor);
      if (amountMinor <= 0) return;
      tenders = [
        ...tenders,
        {
          id: d.newId(),
          kind: "cash",
          amountMinor,
          receivedMinor: Math.trunc(receivedMinor),
          ...(changeMinor > 0 ? { changeMinor } : {}),
        },
      ];
      message = undefined;
      if (remaining(d.payableMinor, tenders) === 0) await finish();
      else emit();
    },

    /** Charges the card for what is left (or `amountMinor` when splitting). */
    async takeCard(amountMinor?: number): Promise<void> {
      if (phase !== "tendering" || d.adapter === undefined || cardBlocked) return;
      const left = remaining(d.payableMinor, tenders);
      const amount = Math.min(amountMinor ?? left, left);
      if (amount <= 0) return;
      phase = "card";
      cardState = undefined;
      message = undefined;
      cancelRequested = false;
      emit();
      let outcome: CardOutcome;
      try {
        outcome = await takeCardPayment({
          adapter: d.adapter,
          amountMinor: amount,
          currency: d.currency,
          reference: d.saleRef,
          attempt: ++attempt,
          online: d.online(),
          cancelled: () => cancelRequested,
          onState: (s) => {
            cardState = s;
            emit();
          },
          ...(d.sleep === undefined ? {} : { sleep: d.sleep }),
          ...(d.now === undefined ? {} : { now: d.now }),
        });
      } catch {
        outcome = {
          ok: false,
          reason: "uncertain",
          message: "Could not confirm the card result. Check the terminal before trying again.",
        };
      }
      cardState = undefined;
      if (!outcome.ok && outcome.reason === "uncertain") cardBlocked = true;
      if (!outcome.ok) {
        phase = "tendering";
        message = {
          tone: outcome.reason === "uncertain" ? "danger" : "info",
          text: outcome.message,
        };
        emit();
        return;
      }
      const card = outcome.intent.card;
      tenders = [
        ...tenders,
        {
          id: d.newId(),
          kind: "card",
          amountMinor: amount,
          card: {
            provider: "terminal",
            providerRef: outcome.intent.id,
            ...(card?.authCode === undefined ? {} : { authCode: card.authCode }),
            ...(card?.last4 === undefined ? {} : { last4: card.last4 }),
            ...(card?.brand === undefined ? {} : { brand: card.brand }),
          },
        },
      ];
      if (remaining(d.payableMinor, tenders) === 0) await finish();
      else {
        phase = "tendering";
        emit();
      }
    },

    /** The cashier checked the terminal: card payments are allowed again. */
    clearCardBlock(): void {
      cardBlocked = false;
      message = undefined;
      emit();
    },

    /** Retries saving a sale that is fully paid but failed to save (same sale id, so it cannot be saved twice). */
    async retrySave(): Promise<void> {
      if (phase !== "tendering" || remaining(d.payableMinor, tenders) !== 0 || tenders.length === 0)
        return;
      await finish();
    },

    /** The cashier gives up on the card prompt. */
    cancelCard(): void {
      cancelRequested = true;
    },

    /** Takes a cash tender back (before the sale is saved). Card tenders are approved money and are not removable here. */
    removeTender(id: string): void {
      if (phase !== "tendering") return;
      const t = tenders.find((x) => x.id === id);
      if (t === undefined || t.kind === "card") return;
      tenders = tenders.filter((x) => x.id !== id);
      emit();
    },

    /** Prints again after a failed print (the sale is already saved). */
    async reprint(): Promise<void> {
      if (phase !== "done" || sale === undefined || d.print === undefined) return;
      try {
        await d.print(sale, tenders);
        printed = "ok";
      } catch {
        printed = "failed";
      }
      emit();
    },

    paid: () => paid(tenders),
  };
}

export type TenderSession = ReturnType<typeof createTenderSession>;
