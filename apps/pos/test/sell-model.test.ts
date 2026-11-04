import { checkDigit } from "@wise-biz/barcode";
import { applySnapshot, createIndexes, openLocalDb } from "@wise-biz/sync";
import { describe, expect, it } from "vitest";

import { createSellContext } from "../src/features/sell/model/context.ts";
import { createSellModel, DRAFT_TTL_MS } from "../src/features/sell/model/sell-model.ts";
import { sessionSlice } from "../src/state/slices.ts";
import { createPosStore } from "../src/state/store.ts";

import { betterSqliteAdapter } from "./support/better-sqlite.ts";

import type { KeyValue } from "../src/state/store.ts";

const withCheck = (body: string) => `${body}${String(checkDigit(body))}`;
const EAN_TEA = withCheck("400638133393");
const EAN_RICE = withCheck("590123412345");
const memory: KeyValue = {
  getItem: () => Promise.resolve(null),
  setItem: () => Promise.resolve(),
  removeItem: () => Promise.resolve(),
};

async function setup(opts: { permissions?: string[] | "all"; clock?: { t: number } } = {}) {
  const db = await openLocalDb(betterSqliteAdapter());
  const t0 = Date.parse("2026-11-02T10:00:00Z");
  const clock = opts.clock ?? { t: t0 };
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
      categoryIds: ["cat1"],
      archived: false,
    },
  });
  await applySnapshot(
    db,
    "catalog",
    {
      cursor: "c",
      rows: [
        variant("v1", "Green Tea 500 g", "GT-500"),
        variant("v2", "Basmati Rice", "BR-1"),
        variant("v3", "Loose Apples", "AP-1"),
        variant("v4", "No Price Item", "NP-1"),
        {
          entity: "barcodes",
          id: "v1",
          version: 1,
          payload: { variantId: "v1", codes: [EAN_TEA] },
        },
        {
          entity: "barcodes",
          id: "v2",
          version: 1,
          payload: { variantId: "v2", codes: [EAN_RICE] },
        },
        // In-store label: prefix 20 + item 01234.
        {
          entity: "barcodes",
          id: "v3",
          version: 1,
          payload: { variantId: "v3", codes: ["2001234"] },
        },
      ],
    },
    clock.t,
  );
  await applySnapshot(
    db,
    "prices",
    {
      cursor: "c",
      rows: [
        {
          entity: "price_list",
          id: "pl1",
          version: 1,
          payload: {
            priceListId: "pl1",
            name: "Main",
            currency: "USD",
            taxRegionId: "tr1",
            branchId: null,
            customerGroup: null,
            validFrom: null,
            validTo: null,
            cashIncrementMinor: null,
            version: 1,
            archived: false,
          },
        },
        {
          entity: "price",
          id: "pl1:v1",
          version: 1,
          payload: { priceListId: "pl1", variantId: "v1", priceMinor: 500 },
        },
        {
          entity: "price",
          id: "pl1:v2",
          version: 1,
          payload: { priceListId: "pl1", variantId: "v2", priceMinor: 800 },
        },
        {
          entity: "price",
          id: "pl1:v3",
          version: 1,
          payload: { priceListId: "pl1", variantId: "v3", priceMinor: 300 },
        },
      ],
    },
    clock.t,
  );
  await applySnapshot(
    db,
    "tax",
    {
      cursor: "c",
      rows: [
        {
          entity: "tax_region",
          id: "tr1",
          version: 1,
          payload: {
            taxRegionId: "tr1",
            code: "US",
            name: "US",
            inclusive: false,
            strategy: "per-line",
            roundingMode: "half-even",
            version: 1,
            rules: [
              {
                id: "r1",
                name: "VAT",
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
    clock.t,
  );
  const store = createPosStore({ storage: memory });
  store.dispatch(
    sessionSlice.actions.booted({
      device: { deviceId: "d", tenantId: "t", branchId: "b1", name: "Till" },
      lowTrust: false,
    }),
  );
  store.dispatch(
    sessionSlice.actions.unlocked({
      userId: "u1",
      sessionId: "s",
      expiresAt: "2026-11-02T20:00:00Z",
      ...(opts.permissions === undefined ? {} : { permissions: opts.permissions }),
    }),
  );
  const indexes = createIndexes(db);
  await indexes.load();
  const metrics: [string, number][] = [];
  let n = 0;
  const ctx = createSellContext(db, "b1", () => clock.t);
  const model = createSellModel({
    store,
    db,
    ctx,
    indexes,
    newId: () => `id${String(++n)}`,
    now: () => clock.t,
    onMetric: (name, ms) => metrics.push([name, ms]),
  });
  await model.refresh();
  return { model, store, db, clock, metrics, ctx };
}

describe("scan and totals", () => {
  it("adds a scanned item, merges the same SKU and prices with tax and timings", async () => {
    const { model, store, metrics } = await setup();
    expect(await model.scan(EAN_TEA)).toMatchObject({ type: "added" });
    await model.scan(EAN_TEA);
    expect(store.getState().cart.ids).toHaveLength(1);
    expect(Object.values(store.getState().cart.entities)[0]?.qty).toBe("2");
    const p = model.pricing();
    expect(p?.totals).toMatchObject({
      subtotalMinor: 1000,
      taxMinor: 100,
      totalMinor: 1100,
      currency: "USD",
    });
    expect(p?.lines[0]).toMatchObject({ name: "Green Tea 500 g", qty: 2, lineTotalMinor: 1100 });
    expect(metrics.map((m) => m[0])).toContain("scan_to_line_ms");
    expect(metrics.map((m) => m[0])).toContain("add_to_totals_ms");
  });

  it("reports an unknown code and an item without a price", async () => {
    const { model, store } = await setup();
    expect(await model.scan("9780306406157")).toEqual({ type: "unknown", code: "9780306406157" });
    expect(await model.addVariant("v4", "1")).toEqual({ type: "no_price", name: "No Price Item" });
    expect(store.getState().cart.ids).toHaveLength(0);
  });

  it("turns a weight label into a quantity", async () => {
    const { model, store } = await setup();
    await model.scan(withCheck("200123401250"));
    expect(Object.values(store.getState().cart.entities)[0]).toMatchObject({
      variantId: "v3",
      qty: "1.25",
    });
    expect(model.pricing()?.totals.subtotalMinor).toBe(375);
  });

  it("is not ready before the first sync", async () => {
    const { model } = await setup();
    const db = await openLocalDb(betterSqliteAdapter());
    const empty = createSellModel({
      store: createPosStore({ storage: memory }),
      db,
      ctx: createSellContext(db, "b1"),
      indexes: createIndexes(db),
      newId: () => "x",
    });
    expect(await empty.refresh()).toBeUndefined();
    expect(await empty.addVariant("v1", "1")).toEqual({ type: "not_ready" });
    expect(empty.pricing()).toBeNull();
    expect(model).toBeDefined();
  });

  it("finds products by name and SKU prefix", async () => {
    const { model } = await setup();
    expect((await model.search("gre")).map((h) => h.variantId)).toEqual(["v1"]);
    expect((await model.search("br-1")).map((h) => h.variantId)).toEqual(["v2"]);
  });

  it("notices when prices change", async () => {
    const { model, db, ctx, clock } = await setup();
    const before = await ctx.fingerprint();
    await db.run(
      "UPDATE entities SET changed_at = ? WHERE dataset = 'prices' AND entity = 'price_list'",
      [new Date(clock.t + 1000).toISOString()],
    );
    expect(await ctx.fingerprint()).not.toBe(before);
    expect(model.ctx).toBe(ctx);
  });
});

describe("editing rules", () => {
  it("lets anyone undo inside the 5 s window, then asks for a supervisor", async () => {
    const { model, store, clock } = await setup();
    const added = await model.addVariant("v1", "1");
    const id = added.type === "added" ? added.lineId : "";
    await model.addVariant("v2", "1");
    clock.t += 4000;
    expect(model.remove(id)).toEqual({ type: "done" });
    expect(store.getState().cart.ids).toHaveLength(1);
    const rice = store.getState().cart.ids[0]!;
    clock.t += 2000;
    expect(model.remove(rice)).toMatchObject({ type: "needs_override", kind: "remove" });
    expect(store.getState().cart.ids).toHaveLength(1);
  });

  it("raising a quantity is never gated; lowering one after the window is", async () => {
    const { model, store, clock } = await setup();
    await model.addVariant("v1", "3");
    const id = store.getState().cart.ids[0]!;
    clock.t += 10_000;
    expect(model.changeQty(id, "4")).toEqual({ type: "done" });
    const edit = model.changeQty(id, "2");
    expect(edit).toMatchObject({ type: "needs_override", kind: "reduce", nextQty: "2" });
    if (edit.type === "needs_override") {
      model.applyApproved(edit, {
        id: "a1",
        permission: "sales:edit_line",
        approverId: "boss",
        requesterId: "u1",
        reason: "customer changed mind",
        subjectId: id,
        at: clock.t,
      });
    }
    expect(store.getState().cart.entities[id]?.qty).toBe("2");
    expect(store.getState().cart.approvals).toHaveLength(1);
  });

  it("an operator with the permission edits freely", async () => {
    const { model, store, clock } = await setup({ permissions: ["sales:edit_line"] });
    await model.addVariant("v1", "1");
    const id = store.getState().cart.ids[0]!;
    clock.t += 60_000;
    expect(model.remove(id)).toEqual({ type: "done" });
    expect(store.getState().cart.ids).toHaveLength(0);
  });
});

describe("park, resume and recovery", () => {
  it("parks, lists, resumes and parks the current cart first", async () => {
    const { model, store } = await setup();
    await model.addVariant("v1", "2");
    const parkedId = await model.park();
    expect(parkedId).toBeDefined();
    expect(store.getState().cart.ids).toHaveLength(0);
    await model.addVariant("v2", "1");
    expect(await model.parked()).toEqual([
      expect.objectContaining({ id: parkedId, itemCount: 2, operatorId: "u1" }),
    ]);
    expect(await model.resume(parkedId!)).toBe(true);
    const names = store.getState().cart.ids.map((i) => store.getState().cart.entities[i]?.name);
    expect(names).toEqual(["Green Tea 500 g"]);
    // The rice cart was parked, not lost.
    expect(await model.parked()).toHaveLength(1);
    expect(await model.resume("nope")).toBe(false);
    expect(await model.park()).toBeDefined();
  });

  it("does not park an empty cart", async () => {
    const { model } = await setup();
    expect(await model.park()).toBeUndefined();
  });

  it("recovers the unfinished cart after a restart and drops it when finished", async () => {
    const { model, store, db } = await setup();
    await model.addVariant("v1", "1");
    await model.flush();
    store.dispatch({ type: "cart/cleared" });
    expect(store.getState().cart.ids).toHaveLength(0);
    expect(await model.recover()).toBe(true);
    expect(store.getState().cart.ids).toHaveLength(1);
    await model.finish();
    expect(await db.all("SELECT * FROM drafts")).toHaveLength(0);
    expect(await model.recover()).toBe(false);
  });

  it("discards drafts past their time to live and corrupt ones", async () => {
    const { model, store, db, clock } = await setup();
    await model.addVariant("v1", "1");
    const id = (await model.park())!;
    clock.t += DRAFT_TTL_MS + 1000;
    expect(await model.parked()).toEqual([]);
    expect(await model.resume(id)).toBe(false);
    await db.run(
      "INSERT INTO drafts (id, operator_id, body, updated_at) VALUES ('bad', 'u1', '{', ?)",
      [clock.t],
    );
    expect(await model.resume("bad")).toBe(false);
    expect(store.getState().cart.ids).toHaveLength(0);
  });
});

describe("small paths", () => {
  it("reads favorites, remembers variants and prices, and reports unpriced ones", async () => {
    const { model, ctx, store } = await setup();
    expect((await model.favorites(2)).map((v) => v.variantId)).toEqual(["v1", "v2"]);
    expect(await ctx.variant("v1")).toBe(await ctx.variant("v1"));
    expect(await ctx.variant("nope")).toBeUndefined();
    expect(await ctx.price("v1")).toBe(500);
    expect(await ctx.price("v1")).toBe(500);
    expect(await ctx.price("v4")).toBeUndefined();
    expect(await ctx.warm(["v1", "v4"])).toEqual(["v4"]);
    expect(await model.addVariant("nope", "1")).toEqual({ type: "unknown", code: "nope" });
    model.setCustomer("c1");
    expect(store.getState().cart.customerId).toBe("c1");
  });

  it("stores a line note and a sale note", async () => {
    const { model, store } = await setup();
    await model.addVariant("v1", "1");
    const id = store.getState().cart.ids[0]!;
    store.dispatch({ type: "cart/lineNoted", payload: { id, note: "gift wrap" } });
    store.dispatch({ type: "cart/noteSet", payload: "for Sam" });
    expect(store.getState().cart.entities[id]?.note).toBe("gift wrap");
    expect(store.getState().cart.note).toBe("for Sam");
  });
});

describe("budgets", () => {
  it("scan to line p95 stays under 50 ms over 500 scans, and re-pricing under 16 ms", async () => {
    const { model, metrics } = await setup();
    for (let i = 0; i < 500; i++) await model.scan(i % 2 === 0 ? EAN_TEA : EAN_RICE);
    const scans = metrics
      .filter((m) => m[0] === "scan_to_line_ms")
      .map((m) => m[1])
      .sort((a, b) => a - b);
    expect(scans).toHaveLength(500);
    expect(scans[Math.floor(scans.length * 0.95)] ?? 0).toBeLessThan(50);
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) model.pricing();
    expect((performance.now() - t0) / 100).toBeLessThan(16);
  });
});

describe("review fixes", () => {
  it("a zero price label is not a free line", async () => {
    const { model, store } = await setup();
    expect(await model.scan(withCheck("210123400000"))).toMatchObject({ type: "unknown" });
    expect(store.getState().cart.ids).toHaveLength(0);
  });

  it("an add that finishes after dispose does not land in the cart", async () => {
    const { model, store } = await setup();
    const pending = model.addVariant("v1", "1");
    model.dispose();
    expect(await pending).toEqual({ type: "not_ready" });
    expect(store.getState().cart.ids).toHaveLength(0);
  });

  it("parking keeps lines scanned while the write ran", async () => {
    const { model, store } = await setup();
    await model.addVariant("v1", "1");
    const parking = model.park();
    const late = model.addVariant("v2", "1");
    await Promise.all([parking, late]);
    const names = store.getState().cart.ids.map((i) => store.getState().cart.entities[i]?.name);
    expect(names).toEqual(["Basmati Rice"]);
  });

  it("an unpriced line shows its name with an error instead of an empty cart", async () => {
    const { model, db } = await setup();
    await model.addVariant("v1", "1");
    await db.run("DELETE FROM entities WHERE dataset = 'prices' AND entity = 'price'");
    await model.refresh();
    // Price memo was cleared by refresh: the engine finds no price for v1.
    const p = model.pricing();
    expect(p?.error).toMatch(/price changed/);
    expect(p?.lines[0]).toMatchObject({ name: "Green Tea 500 g", detail: "No price" });
  });
});
