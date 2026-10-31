import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { VariantUpsertedV1 } from "@wise-biz/module-catalog";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPricingFactsConsumer, createPricingModule } from "../src/index.ts";

import type { Quote } from "../src/index.ts";
import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const OTHER = uuidv7();
let tenantId = T;
let role = "owner";
let device: "active" | "suspended" | null = null;
let now = Date.parse("2026-10-29T10:00:00.000Z");

/** Inventory's batch read, faked: batch id -> its variant and own sale price. */
const batches = new Map<string, { variantId: string; salePriceMinor: number | null }>();
const pricingModule = createPricingModule({
  batchPrices: (_tx, _tenant, ids) =>
    Promise.resolve(
      new Map(
        ids.flatMap((id) => {
          const b = batches.get(id);
          return b === undefined ? [] : [[id, b] as const];
        }),
      ),
    ),
});
const matrix = matrixFromRows(createCatalog(pricingModule.permissions), [
  { role: "owner", permission: "pricing:read" },
  { role: "owner", permission: "pricing:write" },
  { role: "cashier", permission: "pricing:read" },
]);

let pool: pg.Pool;
let worker: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let app: OpenAPIHono<AppEnv>;
const consumer = createPricingFactsConsumer();

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "pricing", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
  worker = createPool(db.url("worker"));
  admin = createPool(db.url("admin"));
  drop = async () => {
    await pool.end();
    await worker.end();
    await admin.end();
    await db.drop();
  };
  app = new OpenAPIHono<AppEnv>({
    defaultHook: (r) => {
      if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  app.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set(
      "auth",
      device === null
        ? {
            kind: "user",
            userId: uuidv7(),
            sessionId: "01900000-0000-7000-8000-0000000000aa",
            tenantId,
            roles: [role],
            branchScope: "all",
            permissionsVersion: 1,
          }
        : { kind: "anonymous" },
    );
    c.set(
      "device",
      device === null
        ? undefined
        : { deviceId: uuidv7(), tenantId, branchId: uuidv7(), status: device },
    );
    c.set("logger", { info: () => undefined } as never);
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    return c.json(p, p.status as 404);
  });
  pricingModule.routes(app, { pool, clock: { now: () => now }, ids: { uuidv7 } });
});
afterAll(async () => {
  await drop();
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(`/v1/pricing${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": `k-${uuidv7()}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <R>(res: Response) => (await res.json()) as R;
async function ok<R>(res: Response, status = 200): Promise<R> {
  if (res.status !== status) throw new Error(`${String(res.status)}: ${await res.text()}`);
  return json<R>(res);
}
const outbox = async (type: string) => {
  const r = await admin.query<{ payload: { data: Record<string, unknown> } }>(
    "select payload from infra.outbox where tenant_id = $1 and type = $2 order by id",
    [tenantId, type],
  );
  return r.rows.map((x) => x.payload.data);
};

/** Builds the event as catalog emits it (contract test) and runs the consumer the way the pg bus does. */
async function deliver(
  variantId: string,
  over: Partial<{ taxCategory: string; categoryIds: string[]; archived: boolean }> = {},
  time = new Date().toISOString(),
  legacy = false,
) {
  const data = {
    productId: uuidv7(),
    variantId,
    productName: "Tea",
    name: "Default",
    sku: `SKU-${variantId.slice(-6)}`,
    barcodes: [],
    unitId: null,
    taxCategory: "standard",
    tracksBatches: false,
    categoryPath: [],
    categoryIds: [],
    tags: [],
    archived: false,
    ...over,
  };
  const e = VariantUpsertedV1.parse({
    id: uuidv7(),
    type: VariantUpsertedV1.type,
    version: 1,
    source: "api/catalog",
    tenantId,
    subject: `variant/${variantId}`,
    time,
    correlationId: "req-12345678",
    actor: { type: "user", id: uuidv7() },
    data,
  });
  // An event emitted before catalog added categoryIds.
  const payload = legacy ? { ...e, data: { ...e.data, categoryIds: undefined } } : e;
  await withTenantTx(worker, { tenantId, requestId: "consumer" }, (client) =>
    consumer.handle(
      { payload: JSON.parse(JSON.stringify(payload)) as unknown },
      { client: client as never },
    ),
  );
}

interface Region {
  id: string;
  version: number;
  rules: { id: string }[];
}
interface List {
  id: string;
  version: number;
  archived: boolean;
}
interface Promo {
  id: string;
  version: number;
  status: string;
}

const vat = { name: "VAT", rateBps: 1800, compound: false, categories: ["standard"], order: 1 };
let seq = 0;
const region = async (over: Record<string, unknown> = {}) =>
  ok<Region>(
    await send("POST", "/tax-regions", {
      code: `lk-${String(seq++)}`,
      name: "Sri Lanka",
      inclusive: true,
      strategy: "per-document",
      rules: [vat],
      ...over,
    }),
    201,
  );
const list = async (over: Record<string, unknown> = {}) => {
  const r = await region();
  return ok<List>(
    await send("POST", "/price-lists", {
      name: `Retail ${String(seq++)}`,
      currency: "LKR",
      taxRegionId: r.id,
      ...over,
    }),
    201,
  );
};

describe("tax regions", () => {
  it("creates with rules, emits the region, and replaces the rule set on update", async () => {
    const r = await region({
      rules: [vat, { ...vat, name: "Levy", rateBps: 250, compound: true, order: 2 }],
    });
    expect(r.rules).toHaveLength(2);
    const [ev] = (await outbox("pricing.tax_region.upserted")).filter(
      (d) => d.taxRegionId === r.id,
    );
    expect(ev).toMatchObject({ inclusive: true, strategy: "per-document", version: 1 });
    const onRegion = await ok<List>(
      await send("POST", "/price-lists", { name: "On region", currency: "LKR", taxRegionId: r.id }),
      201,
    );
    const up = await ok<Region>(
      await send("PUT", `/tax-regions/${r.id}`, {
        version: 1,
        name: "LK",
        inclusive: false,
        strategy: "per-line",
        rules: [vat],
      }),
    );
    expect(up).toMatchObject({ version: 2, rules: [{ name: "VAT" }] });
    // The region is part of the list snapshot: its lists get a new version.
    expect((await ok<List>(await send("GET", `/price-lists/${onRegion.id}`))).version).toBe(
      onRegion.version + 1,
    );
    // Stale version
    const stale = await send("PUT", `/tax-regions/${r.id}`, {
      version: 1,
      name: "LK",
      inclusive: false,
      strategy: "per-line",
      rules: [],
    });
    expect(stale.status).toBe(409);
    const all = await ok<{ taxRegions: Region[] }>(await send("GET", "/tax-regions"));
    expect(all.taxRegions.find((x) => x.id === r.id)?.rules).toHaveLength(1);
  });

  it("rejects a policy the engine rejects (duplicate rule id) and a duplicate code", async () => {
    const id = uuidv7();
    const dup = await send("POST", "/tax-regions", {
      code: "dup-rules",
      name: "X",
      inclusive: false,
      strategy: "per-line",
      rules: [
        { ...vat, id },
        { ...vat, id, order: 2 },
      ],
    });
    expect(dup.status).toBe(422);
    await region({ code: "same" });
    expect(
      (
        await send("POST", "/tax-regions", {
          code: "same",
          name: "Y",
          inclusive: false,
          strategy: "per-line",
          rules: [],
        })
      ).status,
    ).toBe(409);
    const missing = await send("PUT", `/tax-regions/${uuidv7()}`, {
      version: 1,
      name: "x",
      inclusive: false,
      strategy: "per-line",
      rules: [],
    });
    expect(missing.status).toBe(404);
  });
});

describe("price lists and prices", () => {
  it("sets prices in bulk, bumps the version once, and emits only real changes", async () => {
    const l = await list();
    const [a, b, c] = [uuidv7(), uuidv7(), uuidv7()].sort();
    const set1 = await ok<{ version: number; changed: number }>(
      await send("PUT", `/price-lists/${l.id}/prices`, {
        version: 1,
        prices: [
          { variantId: a, priceMinor: 10_000 },
          { variantId: b, priceMinor: 25_000 },
          { variantId: c, priceMinor: 500 },
        ],
      }),
    );
    expect(set1).toEqual({ priceListId: l.id, version: 2, changed: 3 });
    // Same values again: nothing changes, version stays.
    const same = await ok<{ version: number; changed: number }>(
      await send("PUT", `/price-lists/${l.id}/prices`, {
        version: 2,
        prices: [{ variantId: a, priceMinor: 10_000 }],
      }),
    );
    expect(same).toMatchObject({ version: 2, changed: 0 });
    const set2 = await ok<{ version: number }>(
      await send("PUT", `/price-lists/${l.id}/prices`, {
        version: 2,
        prices: [
          { variantId: a, priceMinor: 10_000 },
          { variantId: b, priceMinor: null },
          { variantId: c, priceMinor: 600 },
        ],
      }),
    );
    expect(set2.version).toBe(3);
    const evs = (await outbox("pricing.price.changed")).filter((d) => d.priceListId === l.id);
    expect(evs.map((e) => e.changes)).toEqual([
      [
        { variantId: a, priceMinor: 10_000 },
        { variantId: b, priceMinor: 25_000 },
        { variantId: c, priceMinor: 500 },
      ],
      [
        { variantId: b, priceMinor: null },
        { variantId: c, priceMinor: 600 },
      ],
    ]);
    const stale = await send("PUT", `/price-lists/${l.id}/prices`, {
      version: 2,
      prices: [{ variantId: a, priceMinor: 1 }],
    });
    expect(stale.status).toBe(409);
    const p1 = await ok<{ items: { variantId: string }[]; nextCursor: string | null }>(
      await send("GET", `/price-lists/${l.id}/prices?limit=1`),
    );
    expect(p1).toEqual({ items: [{ variantId: a, priceMinor: 10_000 }], nextCursor: a });
    const p2 = await ok<{ items: unknown[]; nextCursor: string | null }>(
      await send("GET", `/price-lists/${l.id}/prices?limit=5&after=${String(a)}`),
    );
    expect(p2).toEqual({ items: [{ variantId: c, priceMinor: 600 }], nextCursor: null });
    expect((await send("GET", `/price-lists/${uuidv7()}/prices`)).status).toBe(404);
  });

  it("edits, archives and validates lists", async () => {
    const l = await list({ validFrom: "2026-01-01T00:00:00Z" });
    const unknownRegion = await send("POST", "/price-lists", {
      name: "X",
      currency: "LKR",
      taxRegionId: uuidv7(),
    });
    expect(unknownRegion.status).toBe(422);
    const badCurrency = await send("POST", "/price-lists", {
      name: "X",
      currency: "XXQ",
      taxRegionId: uuidv7(),
    });
    expect(badCurrency.status).toBe(422);
    const badWindow = await send("PATCH", `/price-lists/${l.id}`, {
      version: 1,
      validTo: "2025-01-01T00:00:00Z",
    });
    expect(badWindow.status).toBe(422);
    const up = await ok<List & { name: string; validFrom: string | null }>(
      await send("PATCH", `/price-lists/${l.id}`, {
        version: 1,
        name: "Wholesale",
        validFrom: null,
        archived: true,
      }),
    );
    expect(up).toMatchObject({ name: "Wholesale", validFrom: null, archived: true, version: 2 });
    expect((await ok<List>(await send("GET", `/price-lists/${l.id}`))).archived).toBe(true);
    expect((await send("PATCH", `/price-lists/${l.id}`, { version: 1, name: "x" })).status).toBe(
      409,
    );
    expect((await send("PATCH", `/price-lists/${uuidv7()}`, { version: 1 })).status).toBe(404);
    expect((await send("GET", `/price-lists/${uuidv7()}`)).status).toBe(404);
    const all = await ok<{ priceLists: List[] }>(await send("GET", "/price-lists"));
    expect(all.priceLists.at(-1)?.archived).toBe(true);
  });
});

describe("fees and fx", () => {
  it("creates and edits fees; percent fees are capped at 100 %", async () => {
    const f = await ok<{ id: string; version: number }>(
      await send("POST", "/fees", {
        name: "Service",
        kind: "percent",
        value: 1000,
        taxCategory: "standard",
      }),
      201,
    );
    expect(
      (
        await send("POST", "/fees", {
          name: "X",
          kind: "percent",
          value: 10_001,
          taxCategory: "standard",
        })
      ).status,
    ).toBe(422);
    expect((await send("PATCH", `/fees/${f.id}`, { version: 1, value: 20_000 })).status).toBe(422);
    const up = await ok<{ active: boolean; version: number }>(
      await send("PATCH", `/fees/${f.id}`, { version: 1, active: false }),
    );
    expect(up).toMatchObject({ active: false, version: 2 });
    expect((await send("PATCH", `/fees/${f.id}`, { version: 1, active: true })).status).toBe(409);
    expect((await send("PATCH", `/fees/${uuidv7()}`, { version: 1 })).status).toBe(404);
    expect((await ok<{ fees: unknown[] }>(await send("GET", "/fees"))).fees.length).toBeGreaterThan(
      0,
    );
    expect(await outbox("pricing.fee.upserted")).toHaveLength(2);
  });

  it("records FX rates append-only; the latest valid one wins", async () => {
    await ok(
      await send("POST", "/fx-rates", {
        base: "USD",
        quote: "LKR",
        rate: "300.5",
        validFrom: "2026-10-01T00:00:00Z",
      }),
      201,
    );
    await ok(await send("POST", "/fx-rates", { base: "USD", quote: "LKR", rate: "301.25" }), 201);
    await ok(
      await send("POST", "/fx-rates", {
        base: "USD",
        quote: "LKR",
        rate: "999",
        validFrom: "2027-01-01T00:00:00Z",
      }),
      201,
    );
    const cur = await ok<{ fxRates: { base: string; rate: string }[] }>(
      await send("GET", "/fx-rates"),
    );
    expect(cur.fxRates).toEqual([
      expect.objectContaining({ base: "USD", quote: "LKR", rate: "301.25" }),
    ]);
    expect((await send("POST", "/fx-rates", { base: "USD", quote: "USD", rate: "1" })).status).toBe(
      422,
    );
    expect((await send("POST", "/fx-rates", { base: "USD", quote: "LKR", rate: "0" })).status).toBe(
      422,
    );
    expect((await outbox("pricing.fx_rate.recorded"))[0]).toMatchObject({ rate: "300.5" });
  });
});

describe("promotions and coupons", () => {
  const draft = {
    name: "Drinks 10 %",
    target: { kind: "items" },
    effect: { kind: "percent", bps: 1000 },
  };

  it("drafts are editable and silent; publishing freezes and emits; archiving emits", async () => {
    const p = await ok<Promo>(await send("POST", "/promotions", draft), 201);
    expect(p.status).toBe("draft");
    const up = await ok<Promo & { priority: number }>(
      await send("PATCH", `/promotions/${p.id}`, { version: 1, priority: 7 }),
    );
    expect(up).toMatchObject({ priority: 7, version: 2 });
    const bad = await send("PATCH", `/promotions/${p.id}`, {
      version: 2,
      target: { kind: "cart" },
      effect: { kind: "fixed-price", unitPriceMinor: 1 },
    });
    expect(bad.status).toBe(422);
    expect(await outbox("pricing.promotion.published")).toHaveLength(0);
    const pub = await ok<Promo>(await send("POST", `/promotions/${p.id}/publish`, { version: 2 }));
    expect(pub.status).toBe("published");
    expect((await outbox("pricing.promotion.published"))[0]).toMatchObject({
      promotionId: p.id,
      priority: 7,
    });
    expect((await send("PATCH", `/promotions/${p.id}`, { version: 3, priority: 1 })).status).toBe(
      409,
    );
    expect((await send("POST", `/promotions/${p.id}/publish`, { version: 3 })).status).toBe(409);
    const arch = await ok<Promo>(await send("POST", `/promotions/${p.id}/archive`, { version: 3 }));
    expect(arch.status).toBe("archived");
    const draftArchived = await ok<Promo>(await send("POST", "/promotions", draft), 201);
    expect(
      await ok<{ publishedAt: string | null }>(
        await send("POST", `/promotions/${draftArchived.id}/archive`, { version: 1 }),
      ),
    ).toMatchObject({ status: "archived", publishedAt: null });
    expect((await send("POST", `/promotions/${p.id}/archive`, { version: 4 })).status).toBe(409);
    expect(await outbox("pricing.promotion.archived")).toHaveLength(2);
    expect((await send("POST", `/promotions/${p.id}/publish`, { version: 1 })).status).toBe(409);
    expect((await send("GET", `/promotions/${uuidv7()}`)).status).toBe(404);
    expect((await ok<Promo>(await send("GET", `/promotions/${p.id}`))).status).toBe("archived");
    const page = await ok<{ items: Promo[]; nextCursor: string | null }>(
      await send("GET", "/promotions?status=archived&limit=1"),
    );
    expect(page.items[0]?.id).toBe(p.id);
  });

  it("validates promotion shapes", async () => {
    const bad = [
      { ...draft, effect: { kind: "percent", bps: 10_001 } },
      { ...draft, effect: { kind: "bxgy", buy: 0, get: 1, getBps: 10_000 } },
      { ...draft, target: { kind: "cart" }, effect: { kind: "bxgy", buy: 1, get: 1, getBps: 1 } },
      { ...draft, startsAt: "2026-02-01T00:00:00Z", endsAt: "2026-01-01T00:00:00Z" },
      {
        ...draft,
        effect: {
          kind: "bundle",
          components: [
            { variantId: T, qty: 1 },
            { variantId: T, qty: 1 },
          ],
          priceMinor: 1,
        },
      },
    ];
    for (const b of bad) expect((await send("POST", "/promotions", b)).status).toBe(422);
  });

  it("coupons belong to coupon promotions and are unique case-insensitively", async () => {
    const plain = await ok<Promo>(await send("POST", "/promotions", draft), 201);
    expect((await send("POST", `/promotions/${plain.id}/coupons`, { code: "NOPE1" })).status).toBe(
      422,
    );
    const p = await ok<Promo>(
      await send("POST", "/promotions", { ...draft, requiresCoupon: true }),
      201,
    );
    await ok(
      await send("POST", `/promotions/${p.id}/coupons`, { code: "Save10", maxUses: 2 }),
      201,
    );
    expect((await send("POST", `/promotions/${p.id}/coupons`, { code: "SAVE10" })).status).toBe(
      409,
    );
    const list = await ok<{ coupons: { code: string }[] }>(
      await send("GET", `/promotions/${p.id}/coupons`),
    );
    expect(list.coupons.map((c) => c.code)).toEqual(["Save10"]);
    expect((await send("GET", `/promotions/${uuidv7()}/coupons`)).status).toBe(404);
    expect((await send("POST", `/promotions/${uuidv7()}/coupons`, { code: "ABC" })).status).toBe(
      404,
    );
  });
});

describe("quote", () => {
  const drinks = uuidv7();
  const [tea, cake, gone, unknown] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  let listId = "";
  let version = 1;

  beforeAll(async () => {
    tenantId = OTHER; // a clean tenant: no fees or promotions from the other suites
    const l = await list({ cashIncrementMinor: 100 });
    listId = l.id;
    const set = await ok<{ version: number }>(
      await send("PUT", `/price-lists/${l.id}/prices`, {
        version: 1,
        prices: [
          { variantId: tea, priceMinor: 25_000 },
          { variantId: cake, priceMinor: 45_050 },
          { variantId: gone, priceMinor: 100 },
        ],
      }),
    );
    version = set.version;
    await deliver(tea, { categoryIds: [drinks] });
    await deliver(cake, {}, undefined, true);
    await deliver(gone, { archived: true });
    await ok(
      await send("POST", "/fees", {
        name: "Service",
        kind: "percent",
        value: 1000,
        taxCategory: "standard",
      }),
      201,
    );
    const promo = await ok<Promo>(
      await send("POST", "/promotions", {
        name: "Drinks 10 %",
        target: { kind: "items", categoryIds: [drinks] },
        effect: { kind: "percent", bps: 1000 },
      }),
      201,
    );
    await ok(await send("POST", `/promotions/${promo.id}/publish`, { version: 1 }));
    const coupon = await ok<Promo>(
      await send("POST", "/promotions", {
        name: "Coupon 500 off",
        requiresCoupon: true,
        target: { kind: "cart" },
        effect: { kind: "amount", amountMinor: 50_000 },
      }),
      201,
    );
    await ok(
      await send("POST", `/promotions/${coupon.id}/coupons`, { code: "BIG500", maxUses: 1 }),
      201,
    );
    await ok(
      await send("POST", `/promotions/${coupon.id}/coupons`, { code: "USED1", maxUses: 1 }),
      201,
    );
    await ok(await send("POST", `/promotions/${coupon.id}/publish`, { version: 1 }));
    await admin.query(
      "update pricing.coupons set uses = 1 where tenant_id = $1 and code = 'USED1'",
      [OTHER],
    );
    // A future promotion never applies yet.
    const later = await ok<Promo>(
      await send("POST", "/promotions", {
        ...{ name: "Later", target: { kind: "items" }, effect: { kind: "percent", bps: 5000 } },
        startsAt: "2027-01-01T00:00:00Z",
      }),
      201,
    );
    await ok(await send("POST", `/promotions/${later.id}/publish`, { version: 1 }));
  });
  afterAll(() => {
    tenantId = T;
    device = null;
    role = "owner";
  });

  const cart = (over: Record<string, unknown> = {}) => ({
    priceListId: listId,
    lines: [
      { id: "1", variantId: tea, qty: "2" },
      { id: "2", variantId: cake, qty: "1" },
    ],
    ...over,
  });

  it("prices with the engine: category promotion, fee, inclusive VAT, cash rounding, snapshot id", async () => {
    const q = await ok<Quote>(await send("POST", "/quote", cart()));
    expect(q.priceListId).toBe(`${listId}:${String(version)}`);
    expect(q.lines.map((l) => [l.baseMinor, l.amountMinor])).toEqual([
      [50_000, 45_000],
      [45_050, 45_050],
    ]);
    // Service 10 % of 90_050 = 9_005; inclusive: total = 99_055, cash-rounded to 99_100.
    expect(q).toMatchObject({
      feeMinor: 9_005,
      totalMinor: 99_055,
      payableMinor: 99_100,
      cashRoundingMinor: 45,
    });
    expect(q.taxes[0]?.ruleId).toBeDefined();
    expect(q.coupons).toEqual([]);
  });

  it("applies a valid coupon and reports unknown and exhausted ones", async () => {
    const q = await ok<Quote>(
      await send("POST", "/quote", cart({ coupons: ["big500", "USED1", "NOPE"] })),
    );
    expect(q.coupons).toEqual([
      { code: "big500", status: "applied" },
      { code: "USED1", status: "exhausted" },
      { code: "NOPE", status: "unknown" },
    ]);
    expect(q.discountMinor).toBe(5_000 + 50_000);
  });

  it("a batch with its own sale price wins over the list; a foreign batch is refused", async () => {
    const [own, plain, foreign] = [uuidv7(), uuidv7(), uuidv7()];
    batches.set(own, { variantId: tea, salePriceMinor: 20_000 });
    batches.set(plain, { variantId: cake, salePriceMinor: null });
    batches.set(foreign, { variantId: cake, salePriceMinor: 1 });
    const q = await ok<Quote>(
      await send(
        "POST",
        "/quote",
        cart({
          lines: [
            { id: "1", variantId: tea, qty: "2", batchId: own },
            { id: "2", variantId: cake, qty: "1", batchId: plain },
          ],
        }),
      ),
    );
    expect(q.lines.map((l) => [l.priceSource, l.unitPriceMinor])).toEqual([
      ["batch", 20_000],
      ["list", 45_050],
    ]);
    for (const batchId of [foreign, uuidv7()]) {
      const r = await send(
        "POST",
        "/quote",
        cart({ lines: [{ id: "1", variantId: tea, qty: "1", batchId }] }),
      );
      expect(r.status).toBe(422);
    }
  });

  it("rejects unknown and archived variants, and a list not in force", async () => {
    for (const v of [unknown, gone]) {
      const r = await send(
        "POST",
        "/quote",
        cart({ lines: [{ id: "1", variantId: v, qty: "1" }] }),
      );
      expect(r.status).toBe(422);
    }
    const noPrice = await send(
      "POST",
      "/quote",
      cart({
        lines: [
          { id: "1", variantId: tea, qty: "1" },
          { id: "1", variantId: tea, qty: "1" },
        ],
      }),
    );
    expect(noPrice.status).toBe(422);
    now = Date.parse("2020-01-01T00:00:00Z");
    const future = await list({ validFrom: "2026-01-01T00:00:00Z" });
    expect((await send("POST", "/quote", cart({ priceListId: future.id }))).status).toBe(422);
    now = Date.parse("2026-10-29T10:00:00.000Z");
    expect((await send("POST", "/quote", cart({ priceListId: uuidv7() }))).status).toBe(422);
  });

  it("works for an active terminal and a cashier; 401 for a suspended terminal, 404 without the permission", async () => {
    device = "active";
    expect((await send("POST", "/quote", cart())).status).toBe(200);
    device = "suspended";
    expect((await send("POST", "/quote", cart())).status).toBe(401);
    device = null;
    role = "cashier";
    expect((await send("POST", "/quote", cart())).status).toBe(200);
    expect(
      (
        await send("POST", "/fees", {
          name: "X",
          kind: "amount",
          value: 1,
          taxCategory: "standard",
        })
      ).status,
    ).toBe(404);
    role = "nobody";
    expect((await send("POST", "/quote", cart())).status).toBe(404);
    role = "owner";
  });

  it("tenant isolation: another tenant's list is not in force for us", async () => {
    tenantId = T;
    expect((await send("POST", "/quote", cart())).status).toBe(422);
    expect((await send("GET", `/price-lists/${listId}`)).status).toBe(404);
    tenantId = OTHER;
  });

  it("the projection ignores an older event", async () => {
    await deliver(tea, { taxCategory: "zero" }, "2000-01-01T00:00:00.000Z");
    const r = await admin.query<{ tax_category: string }>(
      "select tax_category from pricing.variant_facts where tenant_id = $1 and variant_id = $2",
      [OTHER, tea],
    );
    expect(r.rows[0]?.tax_category).toBe("standard");
  });
});
