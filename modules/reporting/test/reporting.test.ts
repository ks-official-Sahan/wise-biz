import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  onReturnCompleted,
  onSaleCompleted,
  onSaleVoided,
  onShiftOpened,
  rebuild,
} from "../src/apply.ts";
import { createReportingConsumer } from "../src/consumer.ts";
import { reportingModule } from "../src/index.ts";
import { csvCell, operators, salesSummary } from "../src/queries.ts";

import type { Q } from "../src/apply.ts";
import type { AppEnv, IdempotencyCache, ModuleDeps } from "@wise-biz/module-kit";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

const migrationsDir = join(import.meta.dirname, "..", "migrations");
const infraDir = join(import.meta.dirname, "..", "..", "infra", "migrations");
const auditDir = join(import.meta.dirname, "..", "..", "audit", "migrations");

let db: TestDatabase;
let app: pg.Pool;
let worker: pg.Pool;
let admin: pg.Pool;
const ACTOR = uuidv7();

beforeAll(async () => {
  db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: infraDir },
    { module: "audit", dir: auditDir },
    { module: "reporting", dir: migrationsDir },
  ]);
  app = createPool(db.url("app"), { max: 10 });
  worker = createPool(db.url("worker"), { max: 10 });
  admin = createPool(db.url("migrator"));
});
afterAll(async () => {
  await app.end();
  await worker.end();
  await admin.end();
  await db.drop();
});

/** Run as the worker (the consumer's role), inside the business, in one transaction. */
const asWorker = <T>(tenantId: string, fn: (q: Q) => Promise<T>) =>
  withTenantTx(worker, { tenantId, userId: ACTOR, requestId: "test" }, (tx) =>
    fn(tx as unknown as Q),
  );
const asApp = <T>(tenantId: string, fn: (q: Q) => Promise<T>) =>
  withTenantTx(app, { tenantId, userId: ACTOR, requestId: "test" }, (tx) => fn(tx as unknown as Q));

// ---- a small deterministic generator (no dependency): the same seed always builds the same business ----

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GenSale {
  saleId: string;
  operatorId?: string;
  branchId: string;
  terminalId: string;
  shiftId: string;
  businessDate: string;
  lines: {
    variantId: string;
    sku: string;
    qty: string;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
    unitCostMinor: number | null;
  }[];
  tenders: { kind: string; amountMinor: number }[];
  voided: boolean;
}
interface GenReturn {
  returnId: string;
  shiftId: string;
  businessDate: string;
  totalMinor: number;
  lines: { variantId: string; sku: string; qty: string; refundMinor: number }[];
  tenders: { kind: string; amountMinor: number }[];
}

const first = <T>(xs: readonly T[]): T => {
  const x = xs[0];
  if (x === undefined) throw new Error("empty");
  return x;
};

function generate(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const operators = [uuidv7(), uuidv7(), uuidv7()];
  const branches = [uuidv7(), uuidv7()];
  const terminals = branches.flatMap((b) => [uuidv7(), uuidv7()].map((t) => ({ b, t })));
  const variants = Array.from({ length: 6 }, (_, i) => ({
    id: uuidv7(),
    sku: `SKU-${String(i)}`,
    cost: i === 5 ? null : 100 + i * 50,
  }));
  const days = ["2026-11-01", "2026-11-02", "2026-11-03"];
  const shifts = terminals.flatMap((x) =>
    days.map((d) => ({ shiftId: uuidv7(), branchId: x.b, terminalId: x.t, businessDate: d })),
  );
  const sales: GenSale[] = [];
  for (let i = 0; i < 40; i++) {
    const sh = pick(shifts);
    const lines = Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
      const v = pick(variants);
      const qty = pick(["1", "2", "0.5", "3", "1.25"]);
      const total = 100 + Math.floor(r() * 5000);
      return {
        variantId: v.id,
        sku: v.sku,
        qty,
        discountMinor: Math.floor(r() * 50),
        taxMinor: Math.floor(total * 0.08),
        totalMinor: total,
        unitCostMinor: v.cost,
      };
    });
    const payable = lines.reduce((n, l) => n + l.totalMinor, 0);
    const split = Math.floor(payable / 3);
    sales.push({
      saleId: uuidv7(),
      operatorId: pick(operators),
      branchId: sh.branchId,
      terminalId: sh.terminalId,
      shiftId: sh.shiftId,
      businessDate: sh.businessDate,
      lines,
      tenders:
        r() < 0.5
          ? [{ kind: "cash", amountMinor: payable }]
          : [
              { kind: "cash", amountMinor: split },
              { kind: "card", amountMinor: payable - split },
            ],
      voided: r() < 0.2,
    });
  }
  const returns: GenReturn[] = [];
  for (let i = 0; i < 12; i++) {
    const s = pick(sales.filter((x) => !x.voided));
    const l = pick(s.lines);
    const refund = Math.floor(l.totalMinor / 2);
    returns.push({
      returnId: uuidv7(),
      shiftId: s.shiftId,
      businessDate: s.businessDate,
      totalMinor: refund,
      lines: [{ variantId: l.variantId, sku: l.sku, qty: "1", refundMinor: refund }],
      tenders: [{ kind: "cash", amountMinor: refund }],
    });
  }
  return { shifts, sales, returns };
}

const saleEnvelope = (tenantId: string, s: GenSale) => {
  const subtotal = s.lines.reduce((n, l) => n + l.totalMinor, 0);
  return {
    tenantId,
    data: {
      saleId: s.saleId,
      branchId: s.branchId,
      terminalId: s.terminalId,
      ...(s.operatorId === undefined ? {} : { operatorId: s.operatorId }),
      businessDate: s.businessDate,
      currency: "USD",
      subtotalMinor: subtotal,
      discountMinor: s.lines.reduce((n, l) => n + l.discountMinor, 0),
      feeMinor: 0,
      taxMinor: s.lines.reduce((n, l) => n + l.taxMinor, 0),
      payableMinor: subtotal,
      lines: s.lines,
      tenders: s.tenders,
    },
  };
};

/** Independent oracle: totals computed from the generated documents, never from the rollup code. */
function expected(g: ReturnType<typeof generate>) {
  const shift = new Map<string, (typeof g.shifts)[number]>(g.shifts.map((x) => [x.shiftId, x]));
  const day = new Map<
    string,
    {
      sales: number;
      payable: number;
      tax: number;
      voids: number;
      voidValue: number;
      returns: number;
      returned: number;
    }
  >();
  const sku = new Map<string, { qty: number; revenue: number; cost: number; refund: number }>();
  const tender = new Map<string, { sales: number; refunds: number; count: number }>();
  const d = (k: string) =>
    day.get(k) ?? { sales: 0, payable: 0, tax: 0, voids: 0, voidValue: 0, returns: 0, returned: 0 };
  for (const s of g.sales) {
    const k = `${s.businessDate}|${s.terminalId}`;
    const row = d(k);
    const payable = s.lines.reduce((n, l) => n + l.totalMinor, 0);
    if (s.voided) {
      row.voids += 1;
      row.voidValue += payable;
    } else {
      row.sales += 1;
      row.payable += payable;
      row.tax += s.lines.reduce((n, l) => n + l.taxMinor, 0);
      for (const l of s.lines) {
        const a = sku.get(l.variantId) ?? { qty: 0, revenue: 0, cost: 0, refund: 0 };
        a.qty += Number(l.qty);
        a.revenue += l.totalMinor;
        a.cost += l.unitCostMinor === null ? 0 : Math.round(l.unitCostMinor * Number(l.qty));
        sku.set(l.variantId, a);
      }
      for (const t of s.tenders) {
        const a = tender.get(t.kind) ?? { sales: 0, refunds: 0, count: 0 };
        a.sales += t.amountMinor;
        a.count += 1;
        tender.set(t.kind, a);
      }
    }
    day.set(k, row);
  }
  for (const r of g.returns) {
    const sh = shift.get(r.shiftId);
    const k = `${r.businessDate}|${sh?.terminalId ?? ""}`;
    const row = d(k);
    row.returns += 1;
    row.returned += r.totalMinor;
    day.set(k, row);
    for (const l of r.lines) {
      const a = sku.get(l.variantId) ?? { qty: 0, revenue: 0, cost: 0, refund: 0 };
      a.refund += l.refundMinor;
      sku.set(l.variantId, a);
    }
    for (const t of r.tenders) {
      const a = tender.get(t.kind) ?? { sales: 0, refunds: 0, count: 0 };
      a.refunds += t.amountMinor;
      tender.set(t.kind, a);
    }
  }
  return { day, sku, tender };
}

async function snapshot(tenantId: string) {
  return asApp(tenantId, async (q) => {
    const day = await q.query(
      "select business_date::text as d, terminal_id::text as t, sales_count, payable_minor, tax_minor, voids_count, voids_payable_minor, returns_count, returns_minor from reporting.rollup_day order by 1, 2",
    );
    const sku = await q.query(
      "select business_date::text as d, branch_id::text as b, variant_id::text as v, qty::text as qty, revenue_minor, cost_minor, refund_minor from reporting.rollup_sku_day order by 1, 2, 3",
    );
    const tender = await q.query(
      "select business_date::text as d, branch_id::text as b, kind, tx_count, sales_minor, refunds_minor from reporting.rollup_tender_day order by 1, 2, 3",
    );
    return { day: day.rows, sku: sku.rows, tender: tender.rows };
  });
}

async function feed(tenantId: string, g: ReturnType<typeof generate>) {
  for (const s of g.shifts)
    await asWorker(tenantId, (q) =>
      onShiftOpened(q, {
        tenantId,
        data: {
          shiftId: s.shiftId,
          branchId: s.branchId,
          terminalId: s.terminalId,
          businessDate: s.businessDate,
          currency: "USD",
        },
      }),
    );
  for (const s of g.sales) {
    await asWorker(tenantId, (q) => onSaleCompleted(q, saleEnvelope(tenantId, s)));
    if (s.voided)
      await asWorker(tenantId, (q) => onSaleVoided(q, { tenantId, data: { saleId: s.saleId } }));
  }
  for (const r of g.returns)
    await asWorker(tenantId, (q) =>
      onReturnCompleted(q, {
        tenantId,
        data: {
          returnId: r.returnId,
          shiftId: r.shiftId,
          businessDate: r.businessDate,
          currency: "USD",
          totalMinor: r.totalMinor,
          lines: r.lines,
          tenders: r.tenders,
        },
      }),
    );
}

describe("rollups equal an independent aggregation of random data", () => {
  for (const seed of [1, 7, 42]) {
    it(`seed ${String(seed)}: days, products and payments match, voids and returns included`, async () => {
      const tenantId = uuidv7();
      const g = generate(seed);
      await feed(tenantId, g);
      const want = expected(g);
      const got = await snapshot(tenantId);

      for (const row of got.day) {
        const w = want.day.get(`${String(row.d)}|${String(row.t)}`);
        expect(w, `unexpected day row ${String(row.d)}`).toBeDefined();
        expect(Number(row.sales_count)).toBe(w?.sales);
        expect(Number(row.payable_minor)).toBe(w?.payable);
        expect(Number(row.tax_minor)).toBe(w?.tax);
        expect(Number(row.voids_count)).toBe(w?.voids);
        expect(Number(row.voids_payable_minor)).toBe(w?.voidValue);
        expect(Number(row.returns_count)).toBe(w?.returns);
        expect(Number(row.returns_minor)).toBe(w?.returned);
      }
      // Every generated (day, terminal) with any activity has a row.
      expect(got.day.length).toBe(
        [...want.day.values()].filter((x) => x.sales + x.voids + x.returns > 0).length,
      );

      const skuTotals = new Map<
        string,
        { qty: number; revenue: number; cost: number; refund: number }
      >();
      for (const row of got.sku) {
        const a = skuTotals.get(String(row.v)) ?? { qty: 0, revenue: 0, cost: 0, refund: 0 };
        a.qty += Number(row.qty);
        a.revenue += Number(row.revenue_minor);
        a.cost += Number(row.cost_minor);
        a.refund += Number(row.refund_minor);
        skuTotals.set(String(row.v), a);
      }
      for (const [v, w] of want.sku) {
        const a = skuTotals.get(v);
        expect(a?.revenue, `revenue ${v}`).toBe(w.revenue);
        expect(a?.qty).toBeCloseTo(w.qty, 4);
        expect(a?.refund).toBe(w.refund);
      }

      const tenderTotals = new Map<string, { sales: number; refunds: number; count: number }>();
      for (const row of got.tender) {
        const a = tenderTotals.get(String(row.kind)) ?? { sales: 0, refunds: 0, count: 0 };
        a.sales += Number(row.sales_minor);
        a.refunds += Number(row.refunds_minor);
        a.count += Number(row.tx_count);
        tenderTotals.set(String(row.kind), a);
      }
      expect(tenderTotals).toEqual(want.tender);
    });
  }

  it("per-operator sales equal an independent count, and a rebuild reproduces them", async () => {
    const tenantId = uuidv7();
    const g = generate(5);
    await feed(tenantId, g);
    const want = new Map<
      string,
      { sales: number; payable: number; voids: number; voidValue: number }
    >();
    for (const sale of g.sales) {
      const a = want.get(sale.operatorId ?? "") ?? { sales: 0, payable: 0, voids: 0, voidValue: 0 };
      const payable = sale.lines.reduce((n, l) => n + l.totalMinor, 0);
      if (sale.voided) {
        a.voids += 1;
        a.voidValue += payable;
      } else {
        a.sales += 1;
        a.payable += payable;
      }
      want.set(sale.operatorId ?? "", a);
    }
    const read = async () =>
      (
        await asApp(tenantId, (q) =>
          operators(q, tenantId, { from: "2026-11-01", to: "2026-11-03" }),
        )
      )
        .map((r) => [r.operatorId, r.salesCount, r.payableMinor, r.voidsCount, r.voidsPayableMinor])
        .sort();
    const before = await read();
    expect(before).toEqual(
      [...want.entries()].map(([id, a]) => [id, a.sales, a.payable, a.voids, a.voidValue]).sort(),
    );
    await asWorker(tenantId, (q) => rebuild(q, tenantId, "2026-11-01", "2026-11-03"));
    expect(await read()).toEqual(before);
  });

  it("applying every event again changes nothing (redelivery is safe)", async () => {
    const tenantId = uuidv7();
    const g = generate(3);
    await feed(tenantId, g);
    const once = await snapshot(tenantId);
    await feed(tenantId, g);
    expect(await snapshot(tenantId)).toEqual(once);
  });

  it("a rebuild reproduces the incremental rollups exactly, and repeats without drift", async () => {
    const tenantId = uuidv7();
    const g = generate(11);
    await feed(tenantId, g);
    const live = await snapshot(tenantId);
    const first = await asApp(tenantId, (q) => rebuild(q, tenantId, "2026-11-01", "2026-11-03"));
    expect(first.sales).toBe(g.sales.length);
    expect(first.returns).toBe(g.returns.length);
    expect(await snapshot(tenantId)).toEqual(live);
    await asApp(tenantId, (q) => rebuild(q, tenantId, "2026-11-01", "2026-11-03"));
    expect(await snapshot(tenantId)).toEqual(live);
  });

  it("a void that arrives before its sale waits (throws), and works after the sale lands", async () => {
    const tenantId = uuidv7();
    const g = generate(5);
    const s = first(g.sales);
    await expect(
      asWorker(tenantId, (q) => onSaleVoided(q, { tenantId, data: { saleId: s.saleId } })),
    ).rejects.toThrow(/not projected/);
    await asWorker(tenantId, (q) => onSaleCompleted(q, saleEnvelope(tenantId, s)));
    expect(
      await asWorker(tenantId, (q) => onSaleVoided(q, { tenantId, data: { saleId: s.saleId } })),
    ).toBe(true);
    expect(
      await asWorker(tenantId, (q) => onSaleVoided(q, { tenantId, data: { saleId: s.saleId } })),
    ).toBe(false);
  });

  it("a return before its shift waits (throws)", async () => {
    const tenantId = uuidv7();
    const g = generate(5);
    const r = first(g.returns);
    await expect(
      asWorker(tenantId, (q) =>
        onReturnCompleted(q, {
          tenantId,
          data: {
            returnId: r.returnId,
            shiftId: r.shiftId,
            businessDate: r.businessDate,
            currency: "USD",
            totalMinor: r.totalMinor,
            lines: r.lines,
            tenders: r.tenders,
          },
        }),
      ),
    ).rejects.toThrow(/not projected/);
  });

  it("handles a sale with no lines or tenders, and sorts several products and tenders", async () => {
    const t = uuidv7();
    const branchId = uuidv7();
    const terminalId = uuidv7();
    const shiftId = uuidv7();
    await asWorker(t, (q) =>
      onShiftOpened(q, {
        tenantId: t,
        data: { shiftId, branchId, terminalId, businessDate: "2026-11-01", currency: "USD" },
      }),
    );
    const base = { branchId, terminalId, businessDate: "2026-11-01", shiftId };
    const [va, vb] = [uuidv7(), uuidv7()].sort();
    const line = (variantId: string, sku: string, total: number) => ({
      variantId,
      sku,
      qty: "1",
      discountMinor: 0,
      taxMinor: 0,
      totalMinor: total,
      unitCostMinor: null,
    });
    const empty: GenSale = { saleId: uuidv7(), ...base, lines: [], tenders: [], voided: false };
    const mixed: GenSale = {
      saleId: uuidv7(),
      ...base,
      // Listed out of order and repeated, so the sort and the merge both run.
      lines: [line(vb ?? "", "B", 200), line(va ?? "", "A", 100), line(vb ?? "", "B", 50)],
      tenders: [
        { kind: "cash", amountMinor: 150 },
        { kind: "card", amountMinor: 100 },
        { kind: "cash", amountMinor: 100 },
      ],
      voided: false,
    };
    for (const sale of [empty, mixed]) {
      await asWorker(t, (q) => onSaleCompleted(q, saleEnvelope(t, sale)));
      // The same event again changes nothing.
      await asWorker(t, (q) => onSaleCompleted(q, saleEnvelope(t, sale)));
    }
    await asWorker(t, (q) => rebuild(q, t, "2026-11-01", "2026-11-01"));
    for (const sale of [empty, mixed])
      await asWorker(t, (q) => onSaleVoided(q, { tenantId: t, data: { saleId: sale.saleId } }));
    const totals = await asApp(t, (q) =>
      q.query("select coalesce(sum(revenue_minor), 0)::int as n from reporting.rollup_sku_day"),
    );
    expect(totals.rows[0]).toEqual({ n: 0 });
  });

  it("one business never sees another's rollups", async () => {
    const a = uuidv7();
    const b = uuidv7();
    await feed(a, generate(2));
    expect((await snapshot(b)).day).toEqual([]);
  });
});

describe("the consumer", () => {
  it("routes each sales event to its handler and ignores other types", async () => {
    const tenantId = uuidv7();
    const c = createReportingConsumer();
    expect(c.events).toEqual([
      "sales.shift.opened@v1",
      "sales.sale.completed@v1",
      "sales.sale.voided@v1",
      "sales.return.completed@v1",
    ]);
    const g = generate(9);
    const s = first(g.sales);
    await withTenantTx(worker, { tenantId, userId: ACTOR, requestId: "t" }, async (tx) => {
      const client = tx as unknown as pg.PoolClient;
      await c.handle(
        { type: "sales.sale.completed", payload: saleEnvelope(tenantId, s) },
        { client },
      );
      await c.handle({ type: "something.else", payload: {} }, { client });
    });
    expect((await snapshot(tenantId)).day.length).toBe(1);
  });

  it("refuses an event it cannot read, so the bus retries it and then parks it", async () => {
    const tenantId = uuidv7();
    await expect(
      withTenantTx(worker, { tenantId, userId: ACTOR, requestId: "t" }, (tx) =>
        createReportingConsumer().handle(
          { type: "sales.sale.completed", payload: { tenantId, data: { saleId: "nope" } } },
          { client: tx as unknown as pg.PoolClient },
        ),
      ),
    ).rejects.toThrow();
  });
});

// ---- HTTP ----

const matrix = matrixFromRows(createCatalog(reportingModule.permissions), [
  { role: "analyst", permission: "reporting:read" },
  { role: "admin", permission: "reporting:read" },
  { role: "admin", permission: "reporting:manage" },
]);
const cache = new Map<string, string>();
const idempotencyCache: IdempotencyCache = {
  get: (k) => Promise.resolve(cache.get(k) ?? null),
  set: (k, v) => {
    cache.set(k, v);
    return Promise.resolve();
  },
};
function appFor(tenantId: string, role: string) {
  const deps: ModuleDeps = {
    pool: app,
    clock: { now: () => Date.UTC(2026, 10, 4) },
    ids: { uuidv7 },
    idempotencyCache,
  };
  const a = new OpenAPIHono<AppEnv>({
    defaultHook: (r) => {
      if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  a.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", {
      kind: "user",
      userId: ACTOR,
      sessionId: "01900000-0000-7000-8000-0000000000aa",
      tenantId,
      roles: [role],
      branchScope: "all",
      permissionsVersion: 1,
    });
    await next();
  });
  a.use("*", policyMiddleware(matrix));
  reportingModule.routes(a, deps);
  a.onError((err, c) => {
    const p = toProblem(err, "req-12345678");
    return c.json(p, p.status as 404);
  });
  return a;
}
const Q_RANGE = "from=2026-11-01&to=2026-11-03";

describe("reports API", () => {
  const tenantId = uuidv7();
  const g = generate(21);
  beforeAll(async () => {
    await feed(tenantId, g);
  });

  it("sales by day add up to the generated sales, voids and returns", async () => {
    const res = await appFor(tenantId, "analyst").request(
      `/v1/reporting/sales?${Q_RANGE}&groupBy=day`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: {
        salesCount: number;
        voidsCount: number;
        returnsCount: number;
        payableMinor: number;
        returnsMinor: number;
        netMinor: number;
      }[];
    };
    const sum = (f: (r: (typeof body.rows)[number]) => number) =>
      body.rows.reduce((n, r) => n + f(r), 0);
    expect(sum((r) => r.salesCount)).toBe(g.sales.filter((s) => !s.voided).length);
    expect(sum((r) => r.voidsCount)).toBe(g.sales.filter((s) => s.voided).length);
    expect(sum((r) => r.returnsCount)).toBe(g.returns.length);
    expect(sum((r) => r.netMinor)).toBe(sum((r) => r.payableMinor) - sum((r) => r.returnsMinor));
  });

  it("filters by branch and by range", async () => {
    const a = appFor(tenantId, "analyst");
    const branch = g.shifts[0]?.branchId ?? "";
    const one = (await (
      await a.request(`/v1/reporting/sales?${Q_RANGE}&groupBy=branch&branchId=${branch}`)
    ).json()) as { rows: { key: string }[] };
    expect(one.rows.every((r) => r.key === branch)).toBe(true);
    const none = (await (
      await a.request("/v1/reporting/sales?from=2025-01-01&to=2025-01-31")
    ).json()) as { rows: unknown[] };
    expect(none.rows).toEqual([]);
  });

  it("lists best sellers by revenue, with net of tax and profit", async () => {
    const res = await appFor(tenantId, "analyst").request(
      `/v1/reporting/products?${Q_RANGE}&limit=3`,
    );
    const body = (await res.json()) as {
      rows: {
        revenueMinor: number;
        taxMinor: number;
        netMinor: number;
        costMinor: number;
        profitMinor: number;
      }[];
    };
    expect(body.rows.length).toBe(3);
    const rev = body.rows.map((r) => r.revenueMinor);
    expect(rev).toEqual([...rev].sort((x, y) => y - x));
    for (const r of body.rows) {
      expect(r.netMinor).toBe(r.revenueMinor - r.taxMinor);
      expect(r.profitMinor).toBe(r.netMinor - r.costMinor);
    }
  });

  it("reports payments by tender and tax by day", async () => {
    const a = appFor(tenantId, "analyst");
    const pay = (await (await a.request(`/v1/reporting/payments?${Q_RANGE}`)).json()) as {
      rows: { kind: string }[];
    };
    expect(pay.rows.map((r) => r.kind).sort()).toEqual(["card", "cash"]);
    const tx = (await (await a.request(`/v1/reporting/tax?${Q_RANGE}`)).json()) as {
      rows: { day: string; netOfTaxMinor: number; payableMinor: number; taxMinor: number }[];
    };
    expect(tx.rows.map((r) => r.day)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    for (const r of tx.rows) expect(r.netOfTaxMinor).toBe(r.payableMinor - r.taxMinor);
  });

  it("reports sales per operator, for readers only", async () => {
    const res = await appFor(tenantId, "analyst").request(`/v1/reporting/operators?${Q_RANGE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { operatorId: string; salesCount: number; averageMinor: number }[];
    };
    expect(body.rows.length).toBe(new Set(g.sales.map((x) => x.operatorId)).size);
    expect(body.rows.reduce((n, r) => n + r.salesCount, 0)).toBe(
      g.sales.filter((x) => !x.voided).length,
    );
    expect(body.rows.every((r) => r.averageMinor >= 0)).toBe(true);
    expect(
      (await appFor(tenantId, "nobody").request(`/v1/reporting/operators?${Q_RANGE}`)).status,
    ).toBe(404);
  });

  it("exports CSV with a download name, and defuses spreadsheet formulas", async () => {
    const res = await appFor(tenantId, "analyst").request(
      `/v1/reporting/sales.csv?${Q_RANGE}&groupBy=day`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("sales-2026-11-01-2026-11-03.csv");
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe(
      "day,currency,sales,subtotal,discounts,fees,tax,paid,voids,void value,returns,returned,net",
    );
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell("a,b")).toBe('"a,b"');
  });

  it("rejects bad ranges and unknown groupings", async () => {
    const a = appFor(tenantId, "analyst");
    expect((await a.request("/v1/reporting/sales?from=2026-11-03&to=2026-11-01")).status).toBe(422);
    expect((await a.request("/v1/reporting/sales?from=2024-01-01&to=2026-01-01")).status).toBe(422);
    expect((await a.request(`/v1/reporting/sales?${Q_RANGE}&groupBy=customer`)).status).toBe(422);
    expect((await a.request("/v1/reporting/sales")).status).toBe(422);
  });

  it("a reader cannot rebuild, and a manager can, with an audit row", async () => {
    const body = JSON.stringify({ from: "2026-11-01", to: "2026-11-03" });
    const headers = { "content-type": "application/json", "idempotency-key": `k-${uuidv7()}` };
    expect(
      (
        await appFor(tenantId, "analyst").request("/v1/reporting/rebuild", {
          method: "POST",
          headers,
          body,
        })
      ).status,
    ).toBe(404);
    const ok = await appFor(tenantId, "admin").request("/v1/reporting/rebuild", {
      method: "POST",
      headers: { ...headers, "idempotency-key": `k-${uuidv7()}` },
      body,
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { sales: number }).sales).toBe(g.sales.length);
    const tooLong = await appFor(tenantId, "admin").request("/v1/reporting/rebuild", {
      method: "POST",
      headers: { ...headers, "idempotency-key": `k-${uuidv7()}` },
      body: JSON.stringify({ from: "2026-01-01", to: "2026-11-03" }),
    });
    expect(tooLong.status).toBe(422);
  });

  it("hides one business from another", async () => {
    const other = appFor(uuidv7(), "analyst");
    const res = (await (await other.request(`/v1/reporting/sales?${Q_RANGE}`)).json()) as {
      rows: unknown[];
    };
    expect(res.rows).toEqual([]);
  });
});

describe("report speed", () => {
  it("answers a year of 20 branches well under 200 ms (p95 of 20 runs)", async () => {
    const tenantId = uuidv7();
    await withTenantTx(admin, { tenantId, userId: ACTOR, requestId: "seed" }, async (tx) => {
      // 20 branches x 3 terminals x 365 days of day rollups, and 400 products per branch-day sampled sparsely.
      await tx.query(
        `insert into reporting.rollup_day (tenant_id, business_date, branch_id, terminal_id, currency, sales_count,
                                           subtotal_minor, payable_minor, tax_minor)
         select $1, d::date, b.id, t.id, 'USD', 50, 500000, 540000, 40000
           from generate_series('2026-01-01'::date, '2026-12-31'::date, '1 day') d,
                (select uuidv7() as id from generate_series(1, 20)) b0,
                lateral (select b0.id) b,
                lateral (select uuidv7() as id from generate_series(1, 3)) t`,
        [tenantId],
      );
    });
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      await asApp(tenantId, (q) =>
        salesSummary(q, tenantId, { from: "2026-01-01", to: "2026-12-31" }, "branch"),
      );
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95) - 1] ?? 0).toBeLessThan(200);
  });
});
