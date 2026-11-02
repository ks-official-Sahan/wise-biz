import { generateKeyPair, sign } from "@wise-biz/crypto";
import { createHlc, uuidv7 } from "@wise-biz/ids";
import { applySnapshot, createIndexes, createOutbox, openLocalDb } from "@wise-biz/sync";

import { createSellContext } from "../../src/features/sell/model/context.ts";
import { createSellModel } from "../../src/features/sell/model/sell-model.ts";
import { loadLocations } from "../../src/features/tender/model/commit.ts";
import { sessionSlice } from "../../src/state/slices.ts";
import { createPosStore } from "../../src/state/store.ts";

import { betterSqliteAdapter } from "./better-sqlite.ts";

export const linesOf = (store: ReturnType<typeof createPosStore>) =>
  store.getState().cart.ids.flatMap((i) => {
    const l = store.getState().cart.entities[i];
    return l === undefined ? [] : [l];
  });

export const ids = {
  tea: uuidv7(),
  rice: uuidv7(),
  list: uuidv7(),
  loc: uuidv7(),
  loc2: uuidv7(),
  operator: uuidv7(),
};

export async function setup() {
  const db = await openLocalDb(betterSqliteAdapter());
  const t0 = Date.parse("2026-11-02T10:00:00Z");
  const clock = { t: t0 };
  const variant = (id: string, name: string, sku: string) => ({
    entity: "variant",
    id,
    version: 1,
    payload: {
      variantId: id,
      productName: name,
      name,
      sku,
      taxCategory: "std",
      categoryIds: [],
      archived: false,
    },
  });
  await applySnapshot(
    db,
    "catalog",
    { cursor: "c", rows: [variant(ids.tea, "Green Tea", "GT"), variant(ids.rice, "Rice", "RC")] },
    t0,
  );
  await applySnapshot(
    db,
    "prices",
    {
      cursor: "c",
      rows: [
        {
          entity: "price_list",
          id: ids.list,
          version: 3,
          payload: {
            priceListId: ids.list,
            name: "Main",
            currency: "USD",
            taxRegionId: "tr",
            branchId: null,
            customerGroup: null,
            validFrom: null,
            validTo: null,
            cashIncrementMinor: 5,
            version: 3,
            archived: false,
          },
        },
        {
          entity: "price",
          id: `${ids.list}:${ids.tea}`,
          version: 1,
          payload: { priceListId: ids.list, variantId: ids.tea, priceMinor: 503 },
        },
        {
          entity: "price",
          id: `${ids.list}:${ids.rice}`,
          version: 1,
          payload: { priceListId: ids.list, variantId: ids.rice, priceMinor: 800 },
        },
      ],
    },
    t0,
  );
  await applySnapshot(
    db,
    "tax",
    {
      cursor: "c",
      rows: [
        {
          entity: "tax_region",
          id: "tr",
          version: 1,
          payload: {
            taxRegionId: "tr",
            code: "US",
            name: "US",
            inclusive: false,
            strategy: "per-line",
            roundingMode: "half-even",
            version: 1,
            rules: [
              {
                id: "r1",
                name: "VAT 10%",
                rateBps: 1000,
                compound: false,
                categories: ["*"],
                order: 1,
              },
            ],
          },
        },
      ],
    },
    t0,
  );
  await applySnapshot(
    db,
    "stock_branch",
    {
      cursor: "c",
      rows: [
        {
          entity: "stock",
          id: `${ids.loc}:${ids.tea}:-`,
          version: 0,
          payload: { variantId: ids.tea, locationId: ids.loc },
        },
        {
          entity: "stock",
          id: `${ids.loc2}:${ids.rice}:-`,
          version: 0,
          payload: { variantId: ids.rice, locationId: ids.loc2 },
        },
        {
          entity: "stock",
          id: `${ids.loc}:${uuidv7()}:-`,
          version: 0,
          payload: { variantId: uuidv7(), locationId: ids.loc },
        },
      ],
    },
    t0,
  );
  const kp = generateKeyPair();
  const outbox = createOutbox({
    db,
    keys: {
      publicKey: () => Promise.resolve(kp.publicKey),
      sign: (m) => Promise.resolve(sign(m, kp.secretKey)),
    },
    hlc: createHlc({ node: "dev" }),
    ids: { uuidv7 },
    now: () => clock.t,
  });
  const store = createPosStore({
    storage: {
      getItem: () => Promise.resolve(null),
      setItem: () => Promise.resolve(),
      removeItem: () => Promise.resolve(),
    },
  });
  store.dispatch(
    sessionSlice.actions.booted({
      device: { deviceId: "d", tenantId: "t", branchId: "b1", name: "Till" },
      lowTrust: false,
    }),
  );
  store.dispatch(
    sessionSlice.actions.unlocked({
      userId: ids.operator,
      sessionId: "s",
      expiresAt: "2026-11-02T20:00:00Z",
    }),
  );
  const ctx = createSellContext(db, "b1", () => clock.t);
  const model = createSellModel({
    store,
    db,
    ctx,
    indexes: createIndexes(db),
    newId: uuidv7,
    now: () => clock.t,
  });
  await model.refresh();
  const locations = await loadLocations(db);
  const deps = {
    transaction: outbox.transaction,
    ctx: ctx.current!,
    now: () => clock.t,
    newId: uuidv7,
    locationOf: locations.locationOf,
    operatorId: ids.operator,
  };
  return { db, outbox, model, store, ctx, deps, clock, locations };
}
