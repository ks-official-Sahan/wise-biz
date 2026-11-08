/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any -- HTTP bodies are read as loose JSON; the expect() calls are the typed part. */
import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { ensureInventoryPartitions, recordMovements } from "@wise-biz/module-inventory";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
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
const BRANCH = uuidv7();
const LOC = uuidv7();
const VARIANT_A = uuidv7();
const VARIANT_B = uuidv7();
const VARIANT_OLD = uuidv7();

const refs: RefsPort = {
  branchExists: (_tx, _t, id) => Promise.resolve(id === BRANCH),
  locationExists: (_tx, _t, id) => Promise.resolve(id === LOC),
  variantsExist: async (tx, tenantId, ids) => {
    const r = await tx.query<{ variant_id: string }>(
      `select variant_id from inventory.variant_facts
        where tenant_id = $1 and variant_id = any($2::uuid[]) and archived = false`,
      [tenantId, [...ids]],
    );
    return new Set(r.rows.map((x) => x.variant_id));
  },
};

const procurement = createProcurementModule({ stock: { recordMovements }, refs });
const matrix = matrixFromRows(createCatalog(procurement.permissions), [
  { role: "reader", permission: "procurement:read" },
  { role: "clerk", permission: "procurement:read" },
  { role: "clerk", permission: "procurement:write" },
]);

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Pool;
let worker: pg.Pool;
const role = "owner";
const tenantId = T1;

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
  for (const t of [T1, T2]) {
    await admin.query(
      `insert into inventory.variant_facts (tenant_id, variant_id, tracks_batches, archived, source_time)
       values ($1, $2, false, false, now()), ($1, $3, false, false, now()), ($1, $4, false, true, now())`,
      [t, VARIANT_A, VARIANT_B, VARIANT_OLD],
    );
  }
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await worker.end();
  await db.drop();
});

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

const owner = () => appFor(tenantId, role);
const ctx = (t: string) => ({ tenantId: t, requestId: "test" });

async function newSupplier(app: App, name = "Acme Foods") {
  const r = await call(app, "POST", "/suppliers", {
    name,
    contactName: "Dana",
    email: "orders@example.test",
    paymentTermsDays: 30,
    leadTimeDays: 7,
    currency: "USD",
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; version: number; currency: string };
}

async function newPo(
  app: App,
  supplierId: string,
  lines = [
    { variantId: VARIANT_A, orderedQty: "10", unitCostMinor: 250 },
    { variantId: VARIANT_B, orderedQty: "4.5", unitCostMinor: 1000 },
  ],
) {
  const r = await call(app, "POST", "/purchase-orders", {
    supplierId,
    branchId: BRANCH,
    locationId: LOC,
    expectedOn: "2026-12-01",
    notes: "weekly",
    lines,
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; version: number; totalMinor: number; poNo: number; lines: any[] };
}

/** On hand for the variant at the test location (sum over batches; the test never tracks batches). */
async function stockOf(variantId: string, t = tenantId): Promise<number> {
  const r = await admin.query<{ qty: string }>(
    `select coalesce(sum(qty), 0)::text as qty from inventory.stock_balances
      where tenant_id = $1 and location_id = $2 and variant_id = $3`,
    [t, LOC, variantId],
  );
  return Number(r.rows[0]?.qty ?? 0);
}

describe("suppliers and price lists", () => {
  it("creates, edits with a version, archives and lists by keyset", async () => {
    const app = owner();
    const s = await newSupplier(app, "Keyset Co");
    expect(
      (
        await call(app, "PUT", `/suppliers/${s.id}`, {
          name: "Keyset Co",
          version: 99,
          currency: "USD",
        })
      ).status,
    ).toBe(409);
    const edited = await call(app, "PUT", `/suppliers/${s.id}`, {
      name: "Keyset Two",
      version: 1,
      currency: "USD",
      paymentTermsDays: 14,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.version).toBe(2);
    expect((await call(app, "POST", "/suppliers", { name: "x", currency: "usd" })).status).toBe(
      422,
    );

    const archived = await call(app, "POST", `/suppliers/${s.id}/archive`, { version: 2 });
    expect(archived.body.archivedAt).not.toBeNull();
    const active = await call(app, "GET", "/suppliers?limit=200");
    expect(active.body.items.find((x: { id: string }) => x.id === s.id)).toBeUndefined();
    const all = await call(app, "GET", "/suppliers?limit=200&includeArchived=true");
    expect(all.body.items.find((x: { id: string }) => x.id === s.id)).toBeDefined();

    await newSupplier(app, "Second Active");
    await newSupplier(app, "Third Active");
    const p1 = await call(app, "GET", "/suppliers?limit=1");
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await call(app, "GET", `/suppliers?limit=1&after=${String(p1.body.nextCursor)}`);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
    expect((await call(app, "GET", "/suppliers?after=not-a-cursor")).status).toBe(422);
    expect((await call(app, "GET", `/suppliers/${uuidv7()}`)).status).toBe(404);
  });

  it("upserts prices per variant and valid-from, keeps the id, refuses other currencies and archived variants", async () => {
    const app = owner();
    const s = await newSupplier(app, "Price Co");
    const item = {
      variantId: VARIANT_A,
      unitCostMinor: 300,
      currency: "USD",
      minOrderQty: "1",
      validFrom: "2026-11-01",
    };
    const first = await call(app, "PUT", `/suppliers/${s.id}/prices`, { items: [item] });
    expect(first.status).toBe(200);
    const id = first.body.items[0].id;
    const second = await call(app, "PUT", `/suppliers/${s.id}/prices`, {
      items: [{ ...item, unitCostMinor: 275, minOrderQty: "2.5" }],
    });
    expect(second.body.items[0].id).toBe(id);
    expect(second.body.items[0].unitCostMinor).toBe(275);
    expect(second.body.items[0].minOrderQty).toBe("2.5");

    expect(
      (
        await call(app, "PUT", `/suppliers/${s.id}/prices`, {
          items: [{ ...item, currency: "EUR" }],
        })
      ).body.code,
    ).toBe("CURRENCY_MISMATCH");
    expect(
      (
        await call(app, "PUT", `/suppliers/${s.id}/prices`, {
          items: [{ ...item, variantId: VARIANT_OLD }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call(app, "PUT", `/suppliers/${s.id}/prices`, {
          items: [item, { ...item, unitCostMinor: 1 }],
        })
      ).status,
    ).toBe(422);

    const list = await call(app, "GET", `/suppliers/${s.id}/prices?limit=10`);
    expect(list.body.items).toHaveLength(1);
    expect((await call(app, "GET", `/suppliers/${uuidv7()}/prices`)).status).toBe(404);
  });
});

describe("purchase orders", () => {
  it("creates a draft with exact totals and sequential numbers, edits it, and refuses edits once sent", async () => {
    const app = owner();
    const s = await newSupplier(app, "Totals Co");
    const po = await newPo(app, s.id);
    expect(po.totalMinor).toBe(10 * 250 + 4500); // 4.5 x 1000 = 4500 exactly
    const next = await newPo(app, s.id, [
      { variantId: VARIANT_A, orderedQty: "1", unitCostMinor: 1 },
    ]);
    expect(next.poNo).toBe(po.poNo + 1);

    const edited = await call(app, "PUT", `/purchase-orders/${po.id}`, {
      version: po.version,
      expectedOn: null,
      notes: "changed",
      lines: [{ variantId: VARIANT_B, orderedQty: "2", unitCostMinor: 333 }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.totalMinor).toBe(666);
    expect(edited.body.lines).toHaveLength(1);
    expect(
      (await call(app, "PUT", `/purchase-orders/${po.id}`, { version: po.version, lines: [] }))
        .status,
    ).toBe(422);

    const sent = await call(app, "POST", `/purchase-orders/${po.id}/send`, {
      version: edited.body.version,
    });
    expect(sent.body.status).toBe("sent");
    expect(
      (
        await call(app, "PUT", `/purchase-orders/${po.id}`, {
          version: sent.body.version,
          lines: [{ variantId: VARIANT_A, orderedQty: "1", unitCostMinor: 1 }],
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(app, "POST", `/purchase-orders/${po.id}/send`, { version: sent.body.version }))
        .status,
    ).toBe(409);
  });

  it("refuses unknown suppliers, branches, locations and archived or unknown variants with 422", async () => {
    const app = owner();
    const s = await newSupplier(app, "Refs Co");
    const bad = (over: Record<string, unknown>) =>
      call(app, "POST", "/purchase-orders", {
        supplierId: s.id,
        branchId: BRANCH,
        locationId: LOC,
        lines: [{ variantId: VARIANT_A, orderedQty: "1", unitCostMinor: 1 }],
        ...over,
      });
    expect((await bad({ supplierId: uuidv7() })).status).toBe(422);
    expect((await bad({ branchId: uuidv7() })).status).toBe(422);
    expect((await bad({ locationId: uuidv7() })).status).toBe(422);
    expect(
      (await bad({ lines: [{ variantId: VARIANT_OLD, orderedQty: "1", unitCostMinor: 1 }] }))
        .status,
    ).toBe(422);
    expect(
      (await bad({ lines: [{ variantId: VARIANT_A, orderedQty: "0", unitCostMinor: 1 }] })).status,
    ).toBe(422);
  });

  it("cancels a draft or a sent PO, and never a closed one", async () => {
    const app = owner();
    const s = await newSupplier(app, "Cancel Co");
    const draft = await newPo(app, s.id);
    expect(
      (await call(app, "POST", `/purchase-orders/${draft.id}/cancel`, { version: draft.version }))
        .body.status,
    ).toBe("cancelled");
    const sent = await newPo(app, s.id);
    const sentRes = await call(app, "POST", `/purchase-orders/${sent.id}/send`, {
      version: sent.version,
    });
    const cancelled = await call(app, "POST", `/purchase-orders/${sent.id}/cancel`, {
      version: sentRes.body.version,
    });
    expect(cancelled.body.status).toBe("cancelled");
    expect(cancelled.body.cancelledAt).not.toBeNull();
  });
});

describe("receiving", () => {
  it("writes the expected stock receipts, enforces tolerance, closes with variance and records events", async () => {
    const app = owner();
    const before = await stockOf(VARIANT_A);
    const s = await newSupplier(app, "Receive Co");
    const po = await newPo(app, s.id);
    const sent = await call(app, "POST", `/purchase-orders/${po.id}/send`, { version: po.version });

    // Partial receipt: 4 of 10 at the line's unit cost, at the PO's location.
    const r1 = await call(app, "POST", `/purchase-orders/${po.id}/receive`, {
      reference: "DN-100",
      lines: [{ line: 1, qty: "4" }],
    });
    expect(r1.status).toBe(201);
    expect(r1.body.purchaseOrder.status).toBe("partially_received");
    const receiptId = r1.body.receipt.id as string;
    const movements = await admin.query<{
      location_id: string;
      variant_id: string;
      qty: string;
      reason: string;
      unit_cost_minor: string;
      source_line: number;
      source_type: string;
    }>(
      `select location_id, variant_id, qty::text, reason, unit_cost_minor::text, source_line, source_type
         from inventory.stock_movements where tenant_id = $1 and source_id = $2`,
      [tenantId, receiptId],
    );
    expect(movements.rows).toEqual([
      {
        location_id: LOC,
        variant_id: VARIANT_A,
        qty: "4.0000",
        reason: "receive",
        unit_cost_minor: "250",
        source_line: 1,
        source_type: "purchase_order_receipt",
      },
    ]);
    expect(await stockOf(VARIANT_A)).toBe(before + 4);

    // Over-receipt beyond 5 %: 4 + 6.6 = 10.6 > 10.5. Refused, nothing written.
    const over = await call(app, "POST", `/purchase-orders/${po.id}/receive`, {
      lines: [{ line: 1, qty: "6.6" }],
    });
    expect(over.status).toBe(422);
    expect(over.body.errors[0].path).toBe("lines.0.qty");
    expect(await stockOf(VARIANT_A)).toBe(before + 4);

    // Within tolerance: 4 + 6.5 = 10.5 is allowed; the PO is still waiting on line 2.
    const r2 = await call(app, "POST", `/purchase-orders/${po.id}/receive`, {
      lines: [{ line: 1, qty: "6.5" }],
    });
    expect(r2.status).toBe(201);
    expect(r2.body.purchaseOrder.lines[0].receivedQty).toBe("10.5");
    expect(r2.body.purchaseOrder.status).toBe("partially_received");

    const r3 = await call(app, "POST", `/purchase-orders/${po.id}/receive`, {
      lines: [{ line: 2, qty: "4.5" }],
    });
    expect(r3.body.purchaseOrder.status).toBe("received");

    const closed = await call(app, "POST", `/purchase-orders/${po.id}/close`, {
      version: r3.body.purchaseOrder.version,
    });
    expect(closed.body.status).toBe("closed");
    expect(closed.body.lines.map((l: { shortQty: string }) => l.shortQty)).toEqual(["0", "0"]);
    expect(
      (
        await call(app, "POST", `/purchase-orders/${po.id}/cancel`, {
          version: closed.body.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(app, "POST", `/purchase-orders/${po.id}/receive`, {
          lines: [{ line: 1, qty: "1" }],
        })
      ).status,
    ).toBe(409);
    expect(sent.body.status).toBe("sent");

    // Only this PO's events: the outbox is shared by every test in the file.
    const events = await admin.query<{ type: string }>(
      `select type from infra.outbox
        where tenant_id = $1 and topic = 'procurement' and payload->>'subject' = $2 order by id`,
      [tenantId, `purchase-order/${po.id}`],
    );
    expect(events.rows.map((e) => e.type)).toEqual([
      "procurement.po.sent",
      "procurement.po.received",
      "procurement.po.received",
      "procurement.po.received",
      "procurement.po.closed",
    ]);
  });

  it("closes an under-received PO and records the shortfall per line", async () => {
    const app = owner();
    const s = await newSupplier(app, "Short Co");
    const po = await newPo(app, s.id, [
      { variantId: VARIANT_A, orderedQty: "10", unitCostMinor: 100 },
    ]);
    const sent = await call(app, "POST", `/purchase-orders/${po.id}/send`, { version: po.version });
    const r = await call(app, "POST", `/purchase-orders/${po.id}/receive`, {
      lines: [{ line: 1, qty: "2" }],
    });
    expect(r.body.purchaseOrder.status).toBe("partially_received");
    const closed = await call(app, "POST", `/purchase-orders/${po.id}/close`, {
      version: r.body.purchaseOrder.version,
    });
    expect(closed.status).toBe(200);
    expect(closed.body.lines[0]).toMatchObject({ receivedQty: "2", shortQty: "8" });
    expect(sent.status).toBe(200);
  });

  it("replays an idempotent receive without moving stock twice, and refuses a reused key with another body", async () => {
    const app = owner();
    const s = await newSupplier(app, "Replay Co");
    const po = await newPo(app, s.id, [
      { variantId: VARIANT_B, orderedQty: "10", unitCostMinor: 50 },
    ]);
    await call(app, "POST", `/purchase-orders/${po.id}/send`, { version: po.version });
    const key = `recv-${uuidv7()}`;
    const body = { lines: [{ line: 1, qty: "3" }] };
    const first = await call(app, "POST", `/purchase-orders/${po.id}/receive`, body, key);
    const stockAfterFirst = await stockOf(VARIANT_B);
    const replay = await call(app, "POST", `/purchase-orders/${po.id}/receive`, body, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await stockOf(VARIANT_B)).toBe(stockAfterFirst);
    const mismatch = await call(
      app,
      "POST",
      `/purchase-orders/${po.id}/receive`,
      { lines: [{ line: 1, qty: "1" }] },
      key,
    );
    expect(mismatch.body.code).toBe("IDEMPOTENCY_MISMATCH");
  });

  it("serialises two receipts on one line: only the one that fits the tolerance wins", async () => {
    const app = owner();
    const s = await newSupplier(app, "Race Co");
    const po = await newPo(app, s.id, [
      { variantId: VARIANT_B, orderedQty: "10", unitCostMinor: 10 },
    ]);
    await call(app, "POST", `/purchase-orders/${po.id}/send`, { version: po.version });
    const before = await stockOf(VARIANT_B);
    const results = await Promise.all([
      call(app, "POST", `/purchase-orders/${po.id}/receive`, { lines: [{ line: 1, qty: "6" }] }),
      call(app, "POST", `/purchase-orders/${po.id}/receive`, { lines: [{ line: 1, qty: "6" }] }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const now = await admin.query<{ received_qty: string }>(
      "select received_qty::text from procurement.po_lines where tenant_id = $1 and purchase_order_id = $2",
      [tenantId, po.id],
    );
    expect(now.rows[0]?.received_qty).toBe("6.0000");
    expect(await stockOf(VARIANT_B)).toBe(before + 6);
  });

  it("only a principal with procurement:receive can receive; others get 404", async () => {
    const app = owner();
    const s = await newSupplier(app, "Auth Co");
    const po = await newPo(app, s.id, [
      { variantId: VARIANT_A, orderedQty: "1", unitCostMinor: 1 },
    ]);
    await call(app, "POST", `/purchase-orders/${po.id}/send`, { version: po.version });
    const clerk = appFor(tenantId, "clerk");
    const denied = await call(clerk, "POST", `/purchase-orders/${po.id}/receive`, {
      lines: [{ line: 1, qty: "1" }],
    });
    expect(denied.status).toBe(404);
    const reader = await call(appFor(tenantId, "reader"), "GET", `/purchase-orders/${po.id}`);
    expect(reader.status).toBe(200);
    expect(
      (await call(appFor(tenantId, "reader"), "POST", "/suppliers", { name: "x", currency: "USD" }))
        .status,
    ).toBe(404);
  });
});

describe("tenant isolation", () => {
  it("a second tenant sees no suppliers or purchase orders, and the database agrees", async () => {
    const mine = owner();
    const s = await newSupplier(mine, "Isolated Co");
    const po = await newPo(mine, s.id, [
      { variantId: VARIANT_A, orderedQty: "1", unitCostMinor: 1 },
    ]);

    const other = appFor(T2, "owner");
    expect((await call(other, "GET", "/purchase-orders?limit=200")).body.items).toEqual([]);
    expect((await call(other, "GET", "/suppliers?limit=200")).body.items).toEqual([]);
    expect((await call(other, "GET", `/purchase-orders/${po.id}`)).status).toBe(404);
    expect((await call(other, "GET", `/suppliers/${s.id}/prices`)).status).toBe(404);

    const count = await withTenantTx(pool, ctx(T2), (tx) =>
      tx.query<{ n: string }>("select count(*)::text as n from procurement.purchase_orders"),
    );
    expect(count.rows[0]?.n).toBe("0");
    await expect(
      withTenantTx(pool, ctx(T2), (tx) =>
        tx.query(
          `insert into procurement.suppliers (tenant_id, id, name, currency, created_at, updated_at)
           values ($1, $2, 'smuggled', 'USD', now(), now())`,
          [T1, uuidv7()],
        ),
      ),
    ).rejects.toThrow();
  });

  it("list and point queries use their indexes (EXPLAIN with sequential scans off)", async () => {
    const plan = async (sql: string, params: unknown[]) =>
      withTenantTx(pool, ctx(T1), async (tx) => {
        await tx.query("set local enable_seqscan = off");
        const r = await tx.query<{ "QUERY PLAN": unknown }>(`explain (format json) ${sql}`, params);
        return JSON.stringify(r.rows[0]?.["QUERY PLAN"]);
      });
    const status = await plan(
      `select id from procurement.purchase_orders where tenant_id = $1 and status = $2 and id < $3 order by id desc limit $4`,
      [T1, "sent", uuidv7(), 51],
    );
    expect(status).toContain("purchase_orders_status_idx");
    const prices = await plan(
      `select id from procurement.supplier_prices where tenant_id = $1 and supplier_id = $2 and id > $3 order by id limit $4`,
      [T1, uuidv7(), uuidv7(), 51],
    );
    expect(prices).toContain("supplier_prices_list_idx");
    const lines = await plan(
      `select line from procurement.po_lines where tenant_id = $1 and purchase_order_id = any($2::uuid[]) order by purchase_order_id, line`,
      [T1, [uuidv7()]],
    );
    expect(lines).toContain("po_lines_pkey");
  });
});
