import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { VariantUpsertedV1 } from "@wise-biz/module-catalog";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  commitReservations,
  createInventoryFactsConsumer,
  createInventoryModule,
  fromQty4,
  recordMovements,
  releaseReservations,
  reserve,
  selectBatchesFefo,
  toQty4,
} from "../src/index.ts";

import type { MovementInput } from "../src/index.ts";
import type { TxHandle } from "@wise-biz/db";
import type { AppEnv, CommandContext } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const OTHER = uuidv7();
const USER = uuidv7();
let tenantId = T;
let role = "owner";
const LOC = uuidv7();
const LOC2 = uuidv7();
const locations = new Set<string>([LOC, LOC2]);

const inventoryModule = createInventoryModule({
  locationExists: (_tx, _tenant, id) => Promise.resolve(locations.has(id)),
});
const matrix = matrixFromRows(createCatalog(inventoryModule.permissions), [
  { role: "clerk", permission: "inventory:read" },
  { role: "clerk", permission: "inventory:receive" },
  { role: "clerk", permission: "inventory:adjust", conditions: { maxAmountMinor: 1_000 } },
  { role: "manager", permission: "inventory:adjust" },
]);

let pool: pg.Pool;
let worker: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let app: OpenAPIHono<AppEnv>;
const consumer = createInventoryFactsConsumer();

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "inventory", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"), { max: 60 });
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
    c.set("auth", {
      kind: "user",
      userId: USER,
      sessionId: "01900000-0000-7000-8000-0000000000aa",
      tenantId,
      roles: [role],
      branchScope: "all",
      permissionsVersion: 1,
    });
    c.set("logger", { info: () => undefined } as never);
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    if (p.status === 500) console.error(err);
    // Like the authz tests: expose details so the override (approver roles) can be asserted.
    const details = err instanceof DomainError ? err.details : undefined;
    return c.json({ ...p, details }, p.status as 404);
  });
  inventoryModule.routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });
});
afterAll(async () => {
  await drop();
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(`/v1/inventory${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": `k-${uuidv7()}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function ok<R>(res: Response, status = 200): Promise<R> {
  if (res.status !== status) throw new Error(`${String(res.status)}: ${await res.text()}`);
  return (await res.json()) as R;
}
const outbox = async (type: string) => {
  const r = await admin.query<{ payload: { data: Record<string, unknown> } }>(
    "select payload from infra.outbox where tenant_id = $1 and type = $2 order by id",
    [tenantId, type],
  );
  return r.rows.map((x) => x.payload.data);
};

async function variant(tracksBatches = false, time = new Date().toISOString(), archived = false) {
  const variantId = uuidv7();
  await deliver(variantId, tracksBatches, time, archived);
  return variantId;
}
async function deliver(variantId: string, tracksBatches: boolean, time: string, archived = false) {
  const e = VariantUpsertedV1.parse({
    id: uuidv7(),
    type: VariantUpsertedV1.type,
    version: 1,
    source: "api/catalog",
    tenantId,
    subject: `variant/${variantId}`,
    time,
    correlationId: "req-12345678",
    actor: { type: "user", id: USER },
    data: {
      productId: uuidv7(),
      variantId,
      productName: "Milk",
      name: "1L",
      sku: `SKU-${variantId.slice(-8)}`,
      barcodes: [],
      unitId: null,
      taxCategory: "standard",
      tracksBatches,
      categoryPath: [],
      categoryIds: [],
      tags: [],
      archived,
    },
  });
  await withTenantTx(worker, { tenantId, requestId: "consumer" }, (client) =>
    consumer.handle(
      { payload: JSON.parse(JSON.stringify(e)) as unknown },
      { client: client as never },
    ),
  );
}

const ctxFor = (now = new Date()): CommandContext => ({
  tenant: { tenantId, requestId: "req-12345678" },
  userId: USER,
  requestId: "req-12345678",
  now,
  ids: { uuidv7 },
});
const inTx = <R>(fn: (tx: TxHandle) => Promise<R>) =>
  withTenantTx(pool, { tenantId, requestId: "req-12345678" }, fn);

interface Bal {
  locationId: string;
  variantId: string;
  batchId: string | null;
  qty: string;
  reserved: string;
  available: string;
  expiresOn?: string | null;
  salePriceMinor?: number | null;
}
const balances = async (q: string) =>
  ok<{ items: Bal[]; nextCursor: string | null }>(await send("GET", `/balances?${q}`));
const ledgerSum = async (variantId: string) => {
  const r = await admin.query<{ s: string | null }>(
    "select sum(qty)::text as s from inventory.stock_movements where tenant_id = $1 and variant_id = $2",
    [tenantId, variantId],
  );
  return fromQty4(toQty4(r.rows[0]?.s ?? "0"));
};

describe("receive", () => {
  it("receives tracked and untracked variants, creating one batch per tracked line", async () => {
    const [milk, bread] = [await variant(true), await variant(false)];
    const r = await ok<{ id: string; lines: { batchId: string | null }[]; balances: Bal[] }>(
      await send("POST", "/receipts", {
        locationId: LOC,
        currency: "LKR",
        reference: "INV-1",
        lines: [
          {
            variantId: milk,
            qty: "12",
            unitCostMinor: 25_000,
            lotCode: "L1",
            expiresOn: "2026-12-01",
            salePriceMinor: 32_000,
          },
          { variantId: milk, qty: "6.5", unitCostMinor: 26_000, expiresOn: "2026-11-15" },
          { variantId: bread, qty: "20", unitCostMinor: 9_000 },
        ],
      }),
      201,
    );
    expect(r.lines.map((l) => l.batchId === null)).toEqual([false, false, true]);
    const byBatch = await balances(`variantId=${milk}&byBatch=true`);
    expect(byBatch.items.map((b) => [b.qty, b.expiresOn, b.salePriceMinor])).toEqual([
      ["12", "2026-12-01", 32_000],
      ["6.5", "2026-11-15", null],
    ]);
    const summed = await balances(`variantId=${milk}`);
    expect(summed.items).toEqual([
      {
        locationId: LOC,
        variantId: milk,
        batchId: null,
        qty: "18.5",
        reserved: "0",
        available: "18.5",
      },
    ]);
    expect(
      (await outbox("inventory.batch.received")).filter((e) => e.variantId === milk),
    ).toHaveLength(2);
    const mv = (await outbox("inventory.movement.recorded")).filter((e) => e.sourceId === r.id);
    expect(mv.map((e) => [e.variantId, (e.movements as unknown[]).length])).toEqual(
      [
        [milk, 2],
        [bread, 1],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    const keys = await admin.query<{ key: string }>(
      "select key from infra.outbox where tenant_id = $1 and type = 'inventory.batch.received' and payload->'data'->>'variantId' = $2",
      [tenantId, milk],
    );
    expect(keys.rows.map((k) => k.key)).toEqual([`${tenantId}:${milk}`, `${tenantId}:${milk}`]);
    const batches = await ok<{ batches: { lotCode: string | null }[] }>(
      await send("GET", `/batches?variantId=${milk}`),
    );
    expect(batches.batches.map((b) => b.lotCode)).toEqual([null, "L1"]); // earliest expiry first
    expect(await ledgerSum(milk)).toBe("18.5");
  });

  it("rejects unknown locations and variants, batch fields on untracked variants, and a reused id", async () => {
    const bread = await variant(false);
    const line = { variantId: bread, qty: "1", unitCostMinor: 1 };
    expect(
      (await send("POST", "/receipts", { locationId: uuidv7(), currency: "LKR", lines: [line] }))
        .status,
    ).toBe(422);
    expect(
      (
        await send("POST", "/receipts", {
          locationId: LOC,
          currency: "LKR",
          lines: [{ ...line, variantId: uuidv7() }],
        })
      ).status,
    ).toBe(422);
    const archived = await variant(false, undefined, true);
    expect(
      (
        await send("POST", "/receipts", {
          locationId: LOC,
          currency: "LKR",
          lines: [{ ...line, variantId: archived }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await send("POST", "/receipts", {
          locationId: LOC,
          currency: "LKR",
          lines: [{ ...line, lotCode: "X" }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await send("POST", "/receipts", {
          locationId: LOC,
          currency: "LKR",
          lines: [{ ...line, qty: "0" }],
        })
      ).status,
    ).toBe(422);
    const id = uuidv7();
    await ok(
      await send("POST", "/receipts", { id, locationId: LOC, currency: "LKR", lines: [line] }),
      201,
    );
    expect(
      (await send("POST", "/receipts", { id, locationId: LOC, currency: "LKR", lines: [line] }))
        .status,
    ).toBe(409);
  });
});

describe("adjust", () => {
  it("a stock line with no known cost is not free: a value-limited role needs approval for it", async () => {
    const unpriced = await variant(false); // never received anywhere, so no cost basis exists
    role = "clerk";
    try {
      const res = await send("POST", "/adjustments", {
        locationId: LOC,
        reason: "damage",
        lines: [{ variantId: unpriced, qty: "-1" }],
      });
      expect(res.status).toBe(412);
    } finally {
      role = "owner";
    }
    // the owner may still write it off (the value is recorded as 0: nothing was ever received at a cost)
    await ok(
      await send("POST", "/adjustments", {
        locationId: LOC,
        reason: "damage",
        lines: [{ variantId: unpriced, qty: "-1" }],
      }),
      201,
    );
  });

  it("values the adjustment at cost; over the role's limit is 412 with approver roles", async () => {
    const bread = await variant(false);
    await ok(
      await send("POST", "/receipts", {
        locationId: LOC,
        currency: "LKR",
        lines: [{ variantId: bread, qty: "10", unitCostMinor: 300 }],
      }),
      201,
    );
    role = "clerk";
    try {
      // 3 x 300 = 900 <= 1000: allowed for a clerk.
      const small = await ok<{ valueMinor: number; balances: Bal[] }>(
        await send("POST", "/adjustments", {
          locationId: LOC,
          reason: "damage",
          lines: [{ variantId: bread, qty: "-3" }],
        }),
        201,
      );
      expect(small).toMatchObject({ valueMinor: 900, balances: [{ qty: "7" }] });
      // 4 x 300 = 1200 > 1000: needs a manager or the owner, and nothing was written.
      const big = await send("POST", "/adjustments", {
        locationId: LOC,
        reason: "theft",
        lines: [{ variantId: bread, qty: "-4" }],
      });
      expect(big.status).toBe(412);
      const problem = (await big.json()) as { details: { override: { approverRoles: string[] } } };
      expect(problem.details.override.approverRoles).toEqual(["manager", "owner"]);
      expect(await ledgerSum(bread)).toBe("7");
      role = "manager";
      await ok(
        await send("POST", "/adjustments", {
          locationId: LOC,
          reason: "theft",
          lines: [{ variantId: bread, qty: "-4" }],
        }),
        201,
      );
    } finally {
      role = "owner";
    }
    // Negative stock is allowed and announced.
    await ok(
      await send("POST", "/adjustments", {
        locationId: LOC,
        reason: "loss",
        lines: [{ variantId: bread, qty: "-5" }],
      }),
      201,
    );
    const neg = (await outbox("inventory.balance.negative")).filter((e) => e.variantId === bread);
    expect(neg).toEqual([expect.objectContaining({ qty: "-2", sourceType: "adjustment" })]);
  });

  it("tracked variants need a batch of their own; other needs a note", async () => {
    const [milk, bread] = [await variant(true), await variant(false)];
    const rec = await ok<{ lines: { batchId: string }[] }>(
      await send("POST", "/receipts", {
        locationId: LOC,
        currency: "LKR",
        lines: [{ variantId: milk, qty: "5", unitCostMinor: 100 }],
      }),
      201,
    );
    const batchId = rec.lines[0]?.batchId;
    const adj = (lines: unknown[], extra: Record<string, unknown> = {}) =>
      send("POST", "/adjustments", { locationId: LOC, reason: "found", lines, ...extra });
    expect((await adj([{ variantId: milk, qty: "1" }])).status).toBe(422);
    expect((await adj([{ variantId: bread, qty: "1", batchId }])).status).toBe(422);
    expect((await adj([{ variantId: milk, qty: "1", batchId: uuidv7() }])).status).toBe(422);
    expect((await adj([{ variantId: milk, qty: "1", batchId }], { reason: "other" })).status).toBe(
      422,
    );
    const done = await ok<{ valueMinor: number }>(
      await adj([{ variantId: milk, qty: "1.5", batchId }], { reason: "count_correction" }),
      201,
    );
    expect(done.valueMinor).toBe(150);
    // No receipt at this location: cost unknown, valued at 0.
    const elsewhere = await ok<{ valueMinor: number }>(
      await send("POST", "/adjustments", {
        locationId: LOC2,
        reason: "found",
        lines: [{ variantId: bread, qty: "2" }],
      }),
      201,
    );
    expect(elsewhere.valueMinor).toBe(0);
  });
});

describe("port", () => {
  it("FEFO picks the earliest expiry, skips expired batches, and reports a shortfall", async () => {
    const milk = await variant(true);
    const rec = await ok<{ lines: { batchId: string }[] }>(
      await send("POST", "/receipts", {
        locationId: LOC,
        currency: "LKR",
        lines: [
          { variantId: milk, qty: "5", unitCostMinor: 1, expiresOn: "2030-03-01" },
          { variantId: milk, qty: "3", unitCostMinor: 1, expiresOn: "2030-01-01" },
          { variantId: milk, qty: "4", unitCostMinor: 1, expiresOn: "2020-01-01" },
          { variantId: milk, qty: "2", unitCostMinor: 1 },
        ],
      }),
      201,
    );
    const [late, early, expired, none] = rec.lines.map((l) => l.batchId) as [
      string,
      string,
      string,
      string,
    ];
    const pick = (qty: string, includeExpired = false) =>
      inTx((tx) =>
        selectBatchesFefo(tx, tenantId, {
          locationId: LOC,
          variantId: milk,
          qty,
          today: "2026-10-29",
          includeExpired,
        }),
      );
    expect(await pick("6")).toEqual({
      allocations: [
        { batchId: early, qty: "3", expiresOn: "2030-01-01" },
        { batchId: late, qty: "3", expiresOn: "2030-03-01" },
      ],
      shortfall: "0",
    });
    expect((await pick("20")).shortfall).toBe("10");
    expect((await pick("20")).allocations.at(-1)).toEqual({
      batchId: none,
      qty: "2",
      expiresOn: null,
    });
    expect((await pick("1", true)).allocations[0]?.batchId).toBe(expired);

    // Selling an expired batch needs inventory:sell_expired (the caller passes sellExpired).
    const sale = (sellExpired: boolean) =>
      inTx((tx) =>
        recordMovements(
          tx,
          ctxFor(),
          { type: "sale", id: uuidv7(), occurredAt: new Date() },
          [
            {
              locationId: LOC,
              variantId: milk,
              batchId: expired,
              qty: "-1",
              reason: "sale",
              sourceLine: 0,
            },
          ],
          { sellExpired },
        ),
      );
    await expect(sale(false)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await sale(true)).inserted).toBe(1);
  });

  it("replaying a document is a no-op", async () => {
    const bread = await variant(false);
    const source = { type: "sale", id: uuidv7(), occurredAt: new Date("2026-10-29T08:00:00Z") };
    const mv: MovementInput[] = [
      { locationId: LOC, variantId: bread, qty: "-2", reason: "sale", sourceLine: 0 },
      { locationId: LOC, variantId: bread, qty: "-1.25", reason: "sale", sourceLine: 1 },
    ];
    const first = await inTx((tx) => recordMovements(tx, ctxFor(), source, mv));
    const again = await inTx((tx) => recordMovements(tx, ctxFor(), source, mv));
    expect(first).toMatchObject({ inserted: 2, balances: [{ qty: "-3.25" }] });
    expect(first.events.map((e) => e.type)).toEqual([
      "inventory.movement.recorded",
      "inventory.balance.negative",
    ]);
    expect(again).toEqual({ inserted: 0, balances: [], events: [] });
    expect(await ledgerSum(bread)).toBe("-3.25");
    await expect(
      inTx((tx) =>
        recordMovements(tx, ctxFor(), { ...source, id: uuidv7() }, [
          { ...mv[0], qty: "0" } as MovementInput,
        ]),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      inTx((tx) =>
        recordMovements(tx, ctxFor(), { ...source, id: uuidv7() }, [
          ...mv.slice(0, 1),
          ...mv.slice(0, 1),
        ]),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await inTx((tx) => recordMovements(tx, ctxFor(), source, []))).toEqual({
      inserted: 0,
      balances: [],
      events: [],
    });
  });

  it("reservations hold stock, refuse oversell, commit into sale movements and release", async () => {
    const bread = await variant(false);
    await ok(
      await send("POST", "/receipts", {
        locationId: LOC,
        currency: "LKR",
        lines: [{ variantId: bread, qty: "10", unitCostMinor: 1 }],
      }),
      201,
    );
    const order = { type: "order", id: uuidv7() };
    const held = await inTx((tx) =>
      reserve(tx, ctxFor(), order, [
        { locationId: LOC, variantId: bread, qty: "4", sourceLine: 0 },
        { locationId: LOC, variantId: bread, qty: "2", sourceLine: 1 },
      ]),
    );
    expect(held).toEqual([expect.objectContaining({ qty: "10", reserved: "6" })]);
    // Same lines again: no-op.
    await inTx((tx) =>
      reserve(tx, ctxFor(), order, [
        { locationId: LOC, variantId: bread, qty: "4", sourceLine: 0 },
      ]),
    );
    await expect(
      inTx((tx) =>
        reserve(tx, ctxFor(), { type: "order", id: uuidv7() }, [
          { locationId: LOC, variantId: bread, qty: "5", sourceLine: 0 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      inTx((tx) =>
        reserve(tx, ctxFor(), order, [
          { locationId: LOC, variantId: bread, qty: "0", sourceLine: 9 },
        ]),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await inTx((tx) => reserve(tx, ctxFor(), order, []))).toEqual([]);
    const committed = await inTx((tx) =>
      commitReservations(tx, ctxFor(), { ...order, occurredAt: new Date() }),
    );
    expect(committed).toMatchObject({ inserted: 2, balances: [{ qty: "4", reserved: "0" }] });
    // Nothing left open.
    expect(await inTx((tx) => releaseReservations(tx, ctxFor(), order))).toBe(0);
    const other = { type: "layaway", id: uuidv7() };
    await inTx((tx) =>
      reserve(tx, ctxFor(), other, [
        { locationId: LOC, variantId: bread, qty: "3", sourceLine: 0 },
      ]),
    );
    expect(await inTx((tx) => releaseReservations(tx, ctxFor(), other))).toBe(1);
    expect((await balances(`variantId=${bread}`)).items[0]).toMatchObject({
      qty: "4",
      reserved: "0",
      available: "4",
    });
  });

  it("property: for any sequence of movements, balance = sum of the ledger", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            loc: fc.constantFrom(LOC, LOC2),
            qty: fc.integer({ min: -50_000, max: 50_000 }).filter((q) => q !== 0),
            replay: fc.boolean(),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        async (steps) => {
          const v = await variant(false);
          const sources: { type: string; id: string; occurredAt: Date }[] = [];
          for (const [i, s] of steps.entries()) {
            const again = s.replay ? sources[i % Math.max(sources.length, 1)] : undefined;
            const src = again ?? { type: "adjustment", id: uuidv7(), occurredAt: new Date() };
            if (again === undefined) sources.push(src);
            await inTx((tx) =>
              recordMovements(tx, ctxFor(), src, [
                {
                  locationId: s.loc,
                  variantId: v,
                  qty: fromQty4(BigInt(s.qty)),
                  reason: "adjust",
                  sourceLine: 0,
                },
              ]),
            );
          }
          const r = await admin.query<{ ok: boolean }>(
            `select coalesce(sum(b.qty), 0) = coalesce((select sum(m.qty) from inventory.stock_movements m
               where m.tenant_id = $1 and m.variant_id = $2), 0) as ok
             from inventory.stock_balances b where b.tenant_id = $1 and b.variant_id = $2`,
            [tenantId, v],
          );
          expect(r.rows[0]?.ok).toBe(true);
          const perLoc = await admin.query<{ ok: boolean }>(
            `select bool_and(b.qty = (select coalesce(sum(m.qty), 0) from inventory.stock_movements m
               where m.tenant_id = b.tenant_id and m.variant_id = b.variant_id and m.location_id = b.location_id)) as ok
             from inventory.stock_balances b where b.tenant_id = $1 and b.variant_id = $2`,
            [tenantId, v],
          );
          expect(perLoc.rows[0]?.ok).toBe(true);
        },
      ),
      { numRuns: 25 },
    );
  });

  it("50 parallel receive/sell transactions on one SKU: no lost update, no deadlock", async () => {
    const milk = await variant(true);
    const rec = await ok<{ lines: { batchId: string }[] }>(
      await send("POST", "/receipts", {
        locationId: LOC,
        currency: "LKR",
        lines: [
          { variantId: milk, qty: "100", unitCostMinor: 1, expiresOn: "2030-01-01" },
          { variantId: milk, qty: "100", unitCostMinor: 1, expiresOn: "2030-02-01" },
        ],
      }),
      201,
    );
    const [a, b] = rec.lines.map((l) => l.batchId) as [string, string];
    // Each transaction touches both batches and both locations, in opposite input orders: the port sorts keys.
    const jobs = Array.from({ length: 50 }, (_, i) =>
      inTx((tx) =>
        recordMovements(
          tx,
          ctxFor(),
          { type: i % 2 === 0 ? "sale" : "receipt", id: uuidv7(), occurredAt: new Date() },
          (i % 2 === 0
            ? [
                {
                  locationId: LOC,
                  variantId: milk,
                  batchId: a,
                  qty: "-1",
                  reason: "sale" as const,
                },
                {
                  locationId: LOC2,
                  variantId: milk,
                  batchId: b,
                  qty: "-0.5",
                  reason: "sale" as const,
                },
                {
                  locationId: LOC,
                  variantId: milk,
                  batchId: b,
                  qty: "-2",
                  reason: "sale" as const,
                },
              ]
            : [
                {
                  locationId: LOC,
                  variantId: milk,
                  batchId: b,
                  qty: "1",
                  reason: "receive" as const,
                },
                {
                  locationId: LOC2,
                  variantId: milk,
                  batchId: b,
                  qty: "0.25",
                  reason: "receive" as const,
                },
                {
                  locationId: LOC,
                  variantId: milk,
                  batchId: a,
                  qty: "3",
                  reason: "receive" as const,
                },
              ]
          ).map((m, k) => ({ ...m, sourceLine: k })),
        ),
      ),
    );
    await Promise.all(jobs);
    // 25 sales: a -25, b@LOC -50, b@LOC2 -12.5; 25 receipts: a +75, b@LOC +25, b@LOC2 +6.25.
    const byBatch = await balances(`variantId=${milk}&byBatch=true`);
    const get = (loc: string, batch: string | undefined) =>
      byBatch.items.find((x) => x.locationId === loc && x.batchId === batch)?.qty;
    expect([get(LOC, a), get(LOC, b), get(LOC2, b)]).toEqual(["150", "75", "-6.25"]);
    expect(await ledgerSum(milk)).toBe("218.75");
  });
});

describe("queries and thresholds", () => {
  it("pages balances and movements with keysets; expiringBefore filters batches", async () => {
    const [u1, u2, tracked] = [await variant(false), await variant(false), await variant(true)];
    for (const v of [u1, u2, tracked]) {
      const extra = v === tracked ? { expiresOn: "2026-11-01" } : {};
      await ok(
        await send("POST", "/receipts", {
          locationId: LOC2,
          currency: "LKR",
          lines: [{ variantId: v, qty: "1", unitCostMinor: 1, ...extra }],
        }),
        201,
      );
    }
    const vs: string[] = [u1, u2, tracked].sort();
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Bal[]; nextCursor: string | null } = await balances(
        `locationId=${LOC2}&limit=2${cursor === null ? "" : `&after=${cursor}`}`,
      );
      all.push(...page.items.map((x) => x.variantId));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((v) => vs.includes(v))).toEqual(vs);
    const expiring = await balances(`locationId=${LOC2}&expiringBefore=2026-12-01`);
    expect(expiring.items.every((x) => x.expiresOn !== null)).toBe(true);
    expect((await send("GET", "/balances")).status).toBe(422);

    const v = vs[0] ?? "";
    for (let i = 0; i < 3; i++) {
      await ok(
        await send("POST", "/adjustments", {
          locationId: LOC2,
          reason: "found",
          lines: [{ variantId: v, qty: "1" }],
        }),
        201,
      );
    }
    const p1 = await ok<{ items: { qty: string }[]; nextCursor: string }>(
      await send("GET", `/movements?variantId=${v}&limit=2`),
    );
    const p2 = await ok<{ items: unknown[]; nextCursor: string | null }>(
      await send(
        "GET",
        `/movements?variantId=${v}&locationId=${LOC2}&limit=2&before=${encodeURIComponent(p1.nextCursor)}`,
      ),
    );
    expect([p1.items.length, p2.items.length, p2.nextCursor]).toEqual([2, 2, null]);
  });

  it("sets, lists and removes thresholds; batch sale price can be changed", async () => {
    const [v1, v2]: string[] = [uuidv7(), uuidv7()];
    await ok(
      await send("PUT", "/thresholds", {
        locationId: LOC,
        items: [
          { variantId: v1, minQty: "5", maxQty: "50" },
          { variantId: v2, minQty: "2.5" },
        ],
      }),
    );
    expect(
      (
        await send("PUT", "/thresholds", {
          locationId: LOC,
          items: [{ variantId: v1, minQty: "5", maxQty: "1" }],
        })
      ).status,
    ).toBe(422);
    const list = await ok<{ thresholds: { variantId: string; minQty: string }[] }>(
      await send("GET", `/thresholds?locationId=${LOC}`),
    );
    expect(list.thresholds.filter((t) => [v1, v2].includes(t.variantId))).toHaveLength(2);
    await ok(
      await send("PUT", "/thresholds", {
        locationId: LOC,
        items: [{ variantId: v2, minQty: null }],
      }),
    );
    const after = await ok<{ thresholds: { variantId: string }[] }>(
      await send("GET", `/thresholds?locationId=${LOC}`),
    );
    expect(after.thresholds.map((t) => t.variantId)).toContain(v1);
    expect(after.thresholds.map((t) => t.variantId)).not.toContain(v2);

    const milk = await variant(true);
    const rec = await ok<{ lines: { batchId: string }[] }>(
      await send("POST", "/receipts", {
        locationId: LOC,
        currency: "LKR",
        lines: [{ variantId: milk, qty: "1", unitCostMinor: 1 }],
      }),
      201,
    );
    const id = rec.lines[0]?.batchId ?? "";
    const b = await ok<{ salePriceMinor: number | null }>(
      await send("PATCH", `/batches/${id}`, { salePriceMinor: 999 }),
    );
    expect(b.salePriceMinor).toBe(999);
    expect((await outbox("inventory.batch.updated")).at(-1)).toMatchObject({
      batchId: id,
      salePriceMinor: 999,
    });
    expect((await send("PATCH", `/batches/${uuidv7()}`, { salePriceMinor: null })).status).toBe(
      404,
    );
  });

  it("tenant isolation and permissions", async () => {
    const bread = await variant(false);
    await ok(
      await send("POST", "/receipts", {
        locationId: LOC,
        currency: "LKR",
        lines: [{ variantId: bread, qty: "1", unitCostMinor: 1 }],
      }),
      201,
    );
    tenantId = OTHER;
    expect((await balances(`variantId=${bread}`)).items).toEqual([]);
    tenantId = T;
    role = "clerk";
    expect(
      (
        await send("PUT", "/thresholds", {
          locationId: LOC,
          items: [{ variantId: bread, minQty: "1" }],
        })
      ).status,
    ).toBe(404);
    role = "nobody";
    expect((await send("GET", `/balances?variantId=${bread}`)).status).toBe(404);
    role = "owner";
  });

  it("the projection ignores an older event", async () => {
    const v = await variant(true, "2026-10-29T10:00:00.000Z");
    await deliver(v, false, "2000-01-01T00:00:00.000Z");
    const r = await admin.query<{ tracks_batches: boolean }>(
      "select tracks_batches from inventory.variant_facts where tenant_id = $1 and variant_id = $2",
      [tenantId, v],
    );
    expect(r.rows[0]?.tracks_batches).toBe(true);
  });
});
