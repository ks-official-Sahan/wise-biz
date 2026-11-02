import { uuidv7 } from "@wise-biz/ids";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "react-redux";

import { cartSlice } from "../../state/slices.ts";
import { useController } from "../../ui/context.tsx";
import { useAppSelector } from "../../ui/hooks.ts";

import { createSellContext } from "./model/context.ts";
import { createSellModel } from "./model/sell-model.ts";

import type { SellModel } from "./model/sell-model.ts";
import type { CartPricing } from "./model/view.ts";
import type { PosStore } from "../../state/store.ts";

const POLL_MS = 3000;

export interface SellState {
  readonly model: SellModel | undefined;
  /** Null until the first sync produced a price list. */
  readonly pricing: CartPricing | null;
  readonly ready: boolean;
  readonly currency: string | undefined;
  /** Bumps when the pricing context was reloaded (prices, tax or promotions moved). */
  readonly rev: number;
}

/**
 * Builds the sell model for the signed-in operator, keeps its pricing context current (a cheap fingerprint of the
 * synced datasets, polled), recovers the unfinished cart, and re-prices when the cart or the context changes.
 */
export function useSell(onMetric?: (name: string, ms: number) => void): SellState {
  const store = useStore() as unknown as PosStore;
  const controller = useController();
  const operatorId = useAppSelector((s) => s.session.operator?.userId);
  const cart = useAppSelector((s) => s.cart);
  const [model, setModel] = useState<SellModel>();
  const [rev, setRev] = useState(0);
  const metric = useRef(onMetric);
  useEffect(() => {
    metric.current = onMetric;
  });

  useEffect(() => {
    const deps = controller.sellDeps();
    if (deps === undefined || operatorId === undefined) return;
    let alive = true;
    const isAlive = () => alive;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ctx = createSellContext(deps.db, deps.branchId);
    const m = createSellModel({
      store,
      db: deps.db,
      ctx,
      indexes: deps.indexes,
      newId: uuidv7,
      onMetric: (n, ms) => metric.current?.(n, ms),
    });
    (async () => {
      await m.refresh();
      await ctx.warm(Object.values(store.getState().cart.entities).map((l) => l.variantId));
      await m.recover();
      await ctx.warm(Object.values(store.getState().cart.entities).map((l) => l.variantId));
      if (!isAlive()) return;
      setModel(m);
      setRev((r) => r + 1);
      let seen = await ctx.fingerprint();
      timer = setInterval(() => {
        ctx
          .fingerprint()
          .then(async (f) => {
            if (f === seen || !isAlive()) return;
            seen = f;
            await m.refresh();
            await ctx.warm(Object.values(store.getState().cart.entities).map((l) => l.variantId));
            if (isAlive()) setRev((r) => r + 1);
          })
          .catch(() => undefined);
      }, POLL_MS);
    })().catch(() => undefined);
    return () => {
      alive = false;
      if (timer !== undefined) clearInterval(timer);
      // flush reads the cart synchronously before its first await, so clearing right after keeps the draft intact.
      m.flush().catch(() => undefined);
      m.dispose();
      store.dispatch(cartSlice.actions.cleared());
      setModel(undefined);
    };
  }, [controller, operatorId, store]);

  // `cart` and `rev` are the triggers: the model reads the store and the context itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pricing = useMemo(() => model?.pricing() ?? null, [model, cart, rev]);

  return {
    model,
    pricing,
    ready: model?.ctx.current !== undefined,
    currency: model?.ctx.current?.currency,
    rev,
  };
}
