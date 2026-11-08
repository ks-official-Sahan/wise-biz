/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- HTTP bodies are read as loose JSON; the expect() calls are the typed part. */

import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import {
  ensureInventoryPartitions,
  lockStock,
  recordMovements,
  selectBatchesFefo,
} from "@wise-biz/module-inventory";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProcurementModule } from "../src/index.ts";

import type { RefsPort } from "../src/index.ts";
import type { AppEnv } from "@wise-biz/module-kit";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const procurementDir = join(import.meta.dirname, "..", "migrations");

const T1 = uuidv7();
const T2 = uuidv7();
const USER = uuidv7();
const SRC = uuidv7();
const DST = uuidv7();

const refs: RefsPort = {
  branchExists: () => Promise.resolve(true),
  locationExists: (_tx, _t, id) => Promise.resolve(id === SRC || id === DST),
  variantsExist: async (tx, tenantId, ids) => {
    const r = await tx.query<{ variant_id: string }>(
      `select variant_id from inventory.variant_facts
        where tenant_id = $1 and variant_id = any($2::uuid[]) and archived = false`,
      [tenantId, [...ids]],
    );
    return new Set(r.rows.map((x) => x.variant_id));
  },
};

const procurement = createProcurementModule({
  stock: { recordMovements, lockStock, selectBatchesFefo },
  refs,
});
const matrix = matrixFromRows(createCatalog(procurement.permissions), [
  { role: "manager", permission: "procurement:read" },
  { role: "manager", permission: "procurement:write" },
  { role: "manager", permission: "procurement:receive" },
  { role: "reader", permission: "procurement:read" },
  { role: "clerk", permission: "procurement:read" },
  { role: "clerk", permission: "procurement:write" },
  { role: "receiver", permission: "procurement:read" },
  { role: "receiver", permission: "procurement:receive" },
]);

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Pool;
let worker: pg.Pool;

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "inventory", dir: dir("inventory") },
    { module: "procurement", dir: procurementDir },
  ]);
  pool = createPool(db.url("app"), { max: 20 });
  admin = createPool(db.url("admin"));
  worker = createPool(db.url("worker"));
  await ensureInventoryPartitions(worker);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await worker.end();
  await db.drop();
});

const ctx = (t: string) => ({ tenantId: t, requestId: "test" });

/** A batch-tracked variant with the given batches on hand at SRC. Each test gets its own SKU. */
async function seedVariant(
  batches: { qty: string; cost: number; expires: string }[],
  t = T1,
): Promise<string> {
  const variantId = uuidv7();
  await admin.query(
    `insert into inventory.variant_facts (tenant_id, variant_id, tracks_batches, archived, source_time)
     values ($1, $2, true, false, now())`,
    [t, variantId],
  );
  const movements: Parameters<typeof recordMovements>[3][number][] = [];
  for (const [i, b] of batches.entries()) {
    const batchId = uuidv7();
    await admin.query(
      `insert into inventory.batches (tenant_id, id, variant_id, currency, unit_cost_minor, expires_on, received_at)
       values ($1, $2, $3, 'USD', $4, $5, now())`,
      [t, batchId, variantId, b.cost, b.expires],
    );
    movements.push({
      locationId: SRC,
      variantId,
      batchId,
      qty: b.qty,
      reason: "receive" as const,
      sourceLine: i + 1,
      unitCostMinor: b.cost,
    });
  }
  const now = new Date();
  await withTenantTx(pool, ctx(t), (tx) =>
    recordMovements(
      tx,
      {
        tenant: { tenantId: t, requestId: "seed" },
        userId: USER,
        requestId: "seed",
        now,
        ids: { uuidv7 },
      },
      { type: "test_seed", id: uuidv7(), occurredAt: now },
      movements,
    ),
  );
  return variantId;
}

function appFor(t: string, r: string) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (res) => {
      if (!res.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  app.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", {
      kind: "user",
      userId: USER,
      sessionId: "01900000-0000-7000-8000-0000000000aa",
      tenantId: t,
      roles: [r],
      branchScope: "all",
      permissionsVersion: 1,
    });
    c.set("logger", { info: () => undefined } as never);
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  procurement.routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });
  app.onError((err, c) => {
    const problem = toProblem(err, "req-12345678");
    return c.json(problem, problem.status as 404);
  });
  return app;
}

type App = ReturnType<typeof appFor>;

async function call(app: App, method: string, path: string, body?: unknown, key = `k-${uuidv7()}`) {
  const res = await app.request(`/v1/procurement${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json()) as Record<string, any>;
  return { status: res.status, body: json, headers: res.headers };
}

const manager = () => appFor(T1, "manager");

async function newTransfer(app: App, variantId: string, qty: string) {
  const r = await call(app, "POST", "/transfers", {
    fromLocationId: SRC,
    toLocationId: DST,
    lines: [{ variantId, requestedQty: qty }],
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; version: number; lines: any[]; status: string };
}

/** Ledger balance of one variant at one location, summed over batches. */
async function onHand(variantId: string, location: string): Promise<number> {
  const r = await admin.query<{ qty: string }>(
    `select coalesce(sum(qty), 0)::text as qty from inventory.stock_balances
      where tenant_id = $1 and location_id = $2 and variant_id = $3`,
    [T1, location, variantId],
  );
  return Number(r.rows[0]?.qty ?? 0);
}

async function transitLocation(id: string): Promise<string> {
  const r = await admin.query<{ in_transit_location_id: string }>(
    "select in_transit_location_id from procurement.transfers where tenant_id = $1 and id = $2",
    [T1, id],
  );
  return r.rows[0]?.in_transit_location_id ?? "";
}

async function legs(source: string, id: string) {
  const r = await admin.query<{ reason: string; qty: string; location_id: string }>(
    `select reason, qty::text, location_id from inventory.stock_movements
      where tenant_id = $1 and source_type = $2 and source_id = $3 order by source_line`,
    [T1, source, id],
  );
  // numeric(18,4) comes back padded ("-4.0000"); compare canonical values.
  return r.rows.map((x) => ({ ...x, qty: String(Number(x.qty)) }));
}

describe("dispatch and receive move stock through the in-transit location", () => {
  it("dispatch writes exactly two ledger legs for a single-batch line and values what is in transit", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const app = manager();
    const t = await newTransfer(app, v, "4");
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "4" }],
    });
    expect(d.status).toBe(200);
    expect(d.body.status).toBe("dispatched");
    expect(d.body.inTransitQty).toBe("4");
    expect(d.body.inTransitValueMinor).toBe(1200);
    expect(d.body.currency).toBe("USD");

    const ledger = await legs("transfer_dispatch", t.id);
    expect(ledger).toHaveLength(2);
    expect(ledger.map((x) => [x.reason, x.qty])).toEqual([
      ["transfer_out", "-4"],
      ["transfer_in", "4"],
    ]);
    expect(await onHand(v, SRC)).toBe(6);
    expect(await onHand(v, await transitLocation(t.id))).toBe(4);
  });

  it("receive with a shortage writes the write-off at transit and leaves the holding location empty", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const app = manager();
    const t = await newTransfer(app, v, "10");
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "10" }],
    });
    const r = await call(app, "POST", `/transfers/${t.id}/receive`, {
      version: d.body.version,
      lines: [{ line: 1, receivedQty: "8" }],
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("received");
    expect(r.body.lines[0].varianceQty).toBe("-2");
    expect(r.body.inTransitQty).toBe("0");
    const reasons = (await legs("transfer_receive", t.id)).map((x) => [x.reason, x.qty]);
    expect(reasons).toEqual([
      ["transfer_out", "-8"],
      ["transfer_in", "8"],
      ["writeoff", "-2"],
    ]);
    expect(await onHand(v, await transitLocation(t.id))).toBe(0);
    expect(await onHand(v, DST)).toBe(8);
  });

  it("over-receipt within tolerance lands the excess as a count variance, and beyond it is refused", async () => {
    const v = await seedVariant([{ qty: "20", cost: 100, expires: "2030-12-01" }]);
    const app = manager();
    const t = await newTransfer(app, v, "10");
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "10" }],
    });
    const tooMuch = await call(app, "POST", `/transfers/${t.id}/receive`, {
      version: d.body.version,
      lines: [{ line: 1, receivedQty: "11" }],
    });
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    const r = await call(app, "POST", `/transfers/${t.id}/receive`, {
      version: d.body.version,
      lines: [{ line: 1, receivedQty: "10.5" }],
    });
    expect(r.status).toBe(200);
    expect(r.body.lines[0].varianceQty).toBe("0.5");
    expect(await onHand(v, DST)).toBe(10.5);
    expect(await onHand(v, await transitLocation(t.id))).toBe(0);
  });

  it("a dispatch across two batches keeps each batch and its cost, first expiry first", async () => {
    const v = await seedVariant([
      { qty: "6", cost: 300, expires: "2030-06-01" },
      { qty: "20", cost: 500, expires: "2031-06-01" },
    ]);
    const app = manager();
    const t = await newTransfer(app, v, "10");
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "10" }],
    });
    expect(d.status).toBe(200);
    expect(d.body.inTransitValueMinor).toBe(6 * 300 + 4 * 500);
    expect(await legs("transfer_dispatch", t.id)).toHaveLength(4);
    const r = await call(app, "POST", `/transfers/${t.id}/receive`, {
      version: d.body.version,
      lines: [{ line: 1, receivedQty: "10" }],
    });
    expect(r.status).toBe(200);
    expect(await onHand(v, DST)).toBe(10);
  });

  it("refuses a dispatch the source cannot cover, with nothing moved", async () => {
    const v = await seedVariant([{ qty: "3", cost: 300, expires: "2030-06-01" }]);
    const app = manager();
    const t = await newTransfer(app, v, "5");
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "5" }],
    });
    expect(d.status).toBe(409);
    expect(await onHand(v, SRC)).toBe(3);
    expect(await legs("transfer_dispatch", t.id)).toHaveLength(0);
  });
});

describe("state, permissions and idempotency", () => {
  it("replays an idempotent dispatch without moving stock twice", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const app = manager();
    const t = await newTransfer(app, v, "4");
    const key = `k-${uuidv7()}`;
    const body = { version: t.version, lines: [{ line: 1, qty: "4" }] };
    const first = await call(app, "POST", `/transfers/${t.id}/dispatch`, body, key);
    const again = await call(app, "POST", `/transfers/${t.id}/dispatch`, body, key);
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(await legs("transfer_dispatch", t.id)).toHaveLength(2);
  });

  it("two receives racing on one transfer: one lands, the other conflicts", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const app = manager();
    const t = await newTransfer(app, v, "10");
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "10" }],
    });
    const body = { version: d.body.version, lines: [{ line: 1, receivedQty: "10" }] };
    const [a, b] = await Promise.all([
      call(app, "POST", `/transfers/${t.id}/receive`, body),
      call(app, "POST", `/transfers/${t.id}/receive`, body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await onHand(v, DST)).toBe(10);
  });

  it("cancel is for requested transfers only; close needs a received one", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const app = manager();
    const t = await newTransfer(app, v, "2");
    const cancelled = await call(app, "POST", `/transfers/${t.id}/cancel`, { version: t.version });
    expect(cancelled.body.status).toBe("cancelled");
    const u = await newTransfer(app, v, "2");
    const early = await call(app, "POST", `/transfers/${u.id}/close`, { version: u.version });
    expect(early.status).toBe(409);
  });

  it("a user without write permission gets 404 on create, and without receive on receive", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const reader = appFor(T1, "reader");
    const denied = await call(reader, "POST", "/transfers", {
      fromLocationId: SRC,
      toLocationId: DST,
      lines: [{ variantId: v, requestedQty: "1" }],
    });
    expect(denied.status).toBe(404);

    const app = manager();
    const t = await newTransfer(app, v, "1");
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "1" }],
    });
    const receiver = appFor(T1, "clerk");
    const r = await call(receiver, "POST", `/transfers/${t.id}/receive`, {
      version: d.body.version,
      lines: [{ line: 1, receivedQty: "1" }],
    });
    expect(r.status).toBe(404);
  });

  it("another tenant sees 404 and the row is invisible under its RLS context", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const t = await newTransfer(manager(), v, "1");
    const other = appFor(T2, "manager");
    const got = await call(other, "GET", `/transfers/${t.id}`);
    expect(got.status).toBe(404);
    const rows = await withTenantTx(pool, ctx(T2), (tx) =>
      tx.query("select id from procurement.transfers where id = $1", [t.id]),
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe("ledger conservation after random sequences", () => {
  it("source + in-transit + destination + losses always equals what was on hand", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 21 }),
        async (dispatchQty, receivedQty) => {
          const initial = 50;
          const v = await seedVariant([{ qty: String(initial), cost: 100, expires: "2030-12-01" }]);
          const app = manager();
          const t = await newTransfer(app, v, String(dispatchQty));
          const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
            version: t.version,
            lines: [{ line: 1, qty: String(dispatchQty) }],
          });
          expect(d.status).toBe(200);
          const cap = Math.floor(dispatchQty * 1.05);
          const got = Math.min(receivedQty, cap);
          const r = await call(app, "POST", `/transfers/${t.id}/receive`, {
            version: d.body.version,
            lines: [{ line: 1, receivedQty: String(got) }],
          });
          expect(r.status).toBe(200);
          const total = await admin.query<{ qty: string }>(
            `select coalesce(sum(qty), 0)::text as qty from inventory.stock_balances
              where tenant_id = $1 and variant_id = $2`,
            [T1, v],
          );
          // Losses are the write-off and count-variance legs; they are part of the ledger, not missing stock.
          const losses = await admin.query<{ qty: string }>(
            `select coalesce(sum(qty), 0)::text as qty from inventory.stock_movements
              where tenant_id = $1 and variant_id = $2 and reason in ('writeoff', 'count_variance')`,
            [T1, v],
          );
          expect(Number(total.rows[0]?.qty) - Number(losses.rows[0]?.qty)).toBe(initial);
          expect(await onHand(v, await transitLocation(t.id))).toBe(0);
        },
      ),
      { numRuns: 8 },
    );
  });
});

describe("the rest of the transfer lifecycle", () => {
  it("closes a received transfer and refuses a second close", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const app = manager();
    const t = await newTransfer(app, v, "5");
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "5" }],
    });
    const r = await call(app, "POST", `/transfers/${t.id}/receive`, {
      version: d.body.version,
      lines: [{ line: 1, receivedQty: "0" }],
    });
    expect(r.body.lines[0].varianceQty).toBe("-5");
    const closed = await call(app, "POST", `/transfers/${t.id}/close`, { version: r.body.version });
    expect(closed.body.status).toBe("closed");
    const again = await call(app, "POST", `/transfers/${t.id}/close`, {
      version: closed.body.version,
    });
    expect(again.status).toBe(409);
    expect(await onHand(v, DST)).toBe(0);
    expect(await onHand(v, await transitLocation(t.id))).toBe(0);
  });

  it("a nothing-arrived receive writes the whole dispatch off at transit", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const app = manager();
    const t = await newTransfer(app, v, "5");
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "5" }],
    });
    await call(app, "POST", `/transfers/${t.id}/receive`, {
      version: d.body.version,
      lines: [{ line: 1, receivedQty: "0" }],
    });
    const reasons = (await legs("transfer_receive", t.id)).map((x) => [x.reason, x.qty]);
    expect(reasons).toEqual([["writeoff", "-5"]]);
    expect(await onHand(v, DST)).toBe(0);
    expect(await onHand(v, await transitLocation(t.id))).toBe(0);
  });

  it("a two-line transfer dispatches and receives every line, and totals its in-transit value", async () => {
    const a = await seedVariant([{ qty: "10", cost: 200, expires: "2030-12-01" }]);
    const b = await seedVariant([{ qty: "10", cost: 1000, expires: "2030-12-01" }]);
    const app = manager();
    const created = await call(app, "POST", "/transfers", {
      fromLocationId: SRC,
      toLocationId: DST,
      notes: "two lines",
      lines: [
        { variantId: a, requestedQty: "2" },
        { variantId: b, requestedQty: "3" },
      ],
    });
    expect(created.status).toBe(201);
    const t = created.body as { id: string; version: number };
    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [
        { line: 2, qty: "3" },
        { line: 1, qty: "2" },
      ],
    });
    expect(d.status).toBe(200);
    expect(d.body.inTransitValueMinor).toBe(2 * 200 + 3 * 1000);
    expect(d.body.notes).toBe("two lines");
    const r = await call(app, "POST", `/transfers/${t.id}/receive`, {
      version: d.body.version,
      lines: [
        { line: 1, receivedQty: "2" },
        { line: 2, receivedQty: "3" },
      ],
    });
    expect(r.status).toBe(200);
    expect((r.body.lines as { varianceQty: string }[]).map((x) => x.varianceQty)).toEqual([
      "0",
      "0",
    ]);
  });

  it("refuses malformed or out-of-state requests with a problem, and moves nothing", async () => {
    const v = await seedVariant([{ qty: "10", cost: 300, expires: "2030-12-01" }]);
    const app = manager();
    const same = await call(app, "POST", "/transfers", {
      fromLocationId: SRC,
      toLocationId: SRC,
      lines: [{ variantId: v, requestedQty: "1" }],
    });
    expect(same.status).toBeGreaterThanOrEqual(400);
    const unknownLoc = await call(app, "POST", "/transfers", {
      fromLocationId: uuidv7(),
      toLocationId: DST,
      lines: [{ variantId: v, requestedQty: "1" }],
    });
    expect(unknownLoc.status).toBe(422);
    const unknownVariant = await call(app, "POST", "/transfers", {
      fromLocationId: SRC,
      toLocationId: DST,
      lines: [{ variantId: uuidv7(), requestedQty: "1" }],
    });
    expect(unknownVariant.status).toBe(422);

    const t = await newTransfer(app, v, "4");
    const stale = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: 99,
      lines: [{ line: 1, qty: "4" }],
    });
    expect(stale.status).toBe(409);
    const over = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "5" }],
    });
    expect(over.status).toBeGreaterThanOrEqual(400);
    const unknownLine = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 7, qty: "1" }],
    });
    expect(unknownLine.status).toBeGreaterThanOrEqual(400);
    const early = await call(app, "POST", `/transfers/${t.id}/receive`, {
      version: t.version,
      lines: [{ line: 1, receivedQty: "1" }],
    });
    expect(early.status).toBe(409);
    expect(await onHand(v, SRC)).toBe(10);
    expect(await legs("transfer_dispatch", t.id)).toHaveLength(0);

    const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
      version: t.version,
      lines: [{ line: 1, qty: "4" }],
    });
    expect(d.status).toBe(200);
    const cancel = await call(app, "POST", `/transfers/${t.id}/cancel`, {
      version: d.body.version,
    });
    expect(cancel.status).toBe(409);
    const wrongSet = await call(app, "POST", `/transfers/${t.id}/receive`, {
      version: d.body.version,
      lines: [{ line: 3, receivedQty: "1" }],
    });
    expect(wrongSet.status).toBeGreaterThanOrEqual(400);
  });

  it("lists by status with keyset pages, and reads one transfer", async () => {
    const v = await seedVariant([{ qty: "100", cost: 300, expires: "2030-12-01" }]);
    const app = manager();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = await newTransfer(app, v, "1");
      const d = await call(app, "POST", `/transfers/${t.id}/dispatch`, {
        version: t.version,
        lines: [{ line: 1, qty: "1" }],
      });
      expect(d.status).toBe(200);
      ids.push(t.id);
    }
    const first = await call(app, "GET", "/transfers?status=dispatched&limit=2");
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items[0].inTransitQty).toBe("1");
    expect(first.body.nextCursor).not.toBeNull();
    const second = await call(
      app,
      "GET",
      `/transfers?status=dispatched&limit=2&after=${String(first.body.nextCursor)}`,
    );
    expect(second.body.items.length).toBeGreaterThanOrEqual(1);
    const seen = [
      ...(first.body.items as { id: string }[]),
      ...(second.body.items as { id: string }[]),
    ].map((x) => x.id);
    expect(new Set(seen).size).toBe(seen.length);

    const one = await call(app, "GET", `/transfers/${ids[0] ?? ""}`);
    expect(one.status).toBe(200);
    expect(one.body.lines[0].dispatchedQty).toBe("1");
    const missing = await call(app, "GET", `/transfers/${uuidv7()}`);
    expect(missing.status).toBe(404);
  });
});

describe("indexes", () => {
  it("the status-filtered transfer list uses its keyset index", async () => {
    const plan = await withTenantTx(pool, ctx(T1), async (tx) => {
      await tx.query("set local enable_seqscan = off");
      const r = await tx.query<{ "QUERY PLAN": string }>(
        `explain select id from procurement.transfers
          where tenant_id = $1 and status = 'dispatched' order by id desc limit 10`,
        [T1],
      );
      return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("transfers_status_idx");
  });
});
