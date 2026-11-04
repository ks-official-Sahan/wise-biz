import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import {
  CloseShiftSchema,
  CompleteReturnSchema,
  CompleteSaleSchema,
  OpenShiftSchema,
  VoidSaleSchema,
} from "@wise-biz/contracts";
import { countQueries, createPool, instrumentPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { batchSalePrices, recordMovements, selectBatchesFefo } from "@wise-biz/module-inventory";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeShift,
  completeReturn,
  completeSale,
  createSalesModule,
  openShift,
  voidSale,
} from "../src/index.ts";

import type { SalesPorts, TerminalContext } from "../src/index.ts";
import type { TxHandle } from "@wise-biz/db";
import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const OTHER_TENANT = uuidv7();
const BRANCH = uuidv7();
const OTHER_BRANCH = uuidv7();
const USER = uuidv7();
const OPERATOR = uuidv7();
const LOC = uuidv7();
const LIST = uuidv7();
const VARIANT = uuidv7();
const TODAY = new Date().toISOString().slice(0, 10);

const salesModule = createSalesModule();
const matrix = matrixFromRows(createCatalog(salesModule.permissions), [
  { role: "viewer", permission: "sales:read" },
  { role: "nobody", permission: "sales:sell" },
]);
const ports: SalesPorts = {
  inventory: { recordMovements, batches: batchSalePrices, selectBatchesFefo },
  pricing: {
    quote: (_tx, _t, input) =>
      Promise.resolve({
        engine: "1.0.0",
        priceListId: `${input.priceListId}:1`,
        totalMinor: 1000,
        payableMinor: 1000,
        lines: [{ lineDiscounts: [], cartDiscounts: [] }],
      }),
  },
  tenancy: {
    operators: (_tx, _t, ids) =>
      Promise.resolve(
        new Map(ids.map((id) => [id, { active: true, permissions: "all" as const }])),
      ),
    policyVersion: () => Promise.resolve(1),
  },
};

let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let app: OpenAPIHono<AppEnv>;
let role = "viewer";
let scope: "all" | string[] = "all";
let tenantId = T;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "inventory", dir: dir("inventory") },
    { module: "sales", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"), { max: 10 });
  instrumentPool(pool);
  admin = createPool(db.url("admin"));
  drop = async () => {
    await pool.end();
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
      branchScope: scope,
      permissionsVersion: 1,
    });
    c.set("logger", { info: () => undefined } as never);
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    return c.json(p, p.status as 404);
  });
  salesModule.routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });
});
afterAll(async () => {
  await drop();
});

const tx = <R>(fn: (tx: TxHandle) => Promise<R>, tenant = T) =>
  withTenantTx(pool, { tenantId: tenant, requestId: "req-12345678" }, fn);
const get = (path: string) => app.request(`/v1/sales${path}`);
const json = async <R>(res: Response, status = 200): Promise<R> => {
  if (res.status !== status) throw new Error(`${String(res.status)}: ${await res.text()}`);
  return (await res.json()) as R;
};
const seqs = new Map<string, number>();
const meta = (t: TerminalContext) => {
  const deviceSeq = seqs.get(t.terminalId) ?? 0;
  seqs.set(t.terminalId, deviceSeq + 1);
  return {
    deviceSeq,
    prevHash: randomBytes(32).toString("base64"),
    hash: randomBytes(32).toString("base64"),
    signature: randomBytes(64).toString("base64"),
  };
};
const iso = () => new Date().toISOString();

async function till(branchId = BRANCH, tenant = T) {
  const t: TerminalContext = {
    tenantId: tenant,
    terminalId: uuidv7(),
    branchId,
    requestId: "req-12345678",
    now: new Date(),
    ids: { uuidv7 },
  };
  const shift = OpenShiftSchema.parse({
    id: uuidv7(),
    operatorId: OPERATOR,
    businessDate: TODAY,
    openedAt: iso(),
    currency: "USD",
    openingFloatMinor: 0,
    meta: meta(t),
  });
  await tx((x) => openShift(x, ports, t, shift), tenant);
  let n = 0;
  return {
    t,
    shiftId: shift.id,
    nextNo: () => ++n,
    tenant,
  };
}
type Till = Awaited<ReturnType<typeof till>>;
async function sell(k: Till, over: { flags?: boolean } = {}) {
  const cmd = CompleteSaleSchema.parse({
    id: uuidv7(),
    shiftId: k.shiftId,
    operatorId: OPERATOR,
    saleNo: k.nextNo(),
    currency: "USD",
    businessDate: TODAY,
    completedAt: iso(),
    priceListId: LIST,
    priceListVersion: 1,
    engineVersion: "1.0.0",
    // Declaring an older engine makes the server flag stale_price.
    ...(over.flags === true ? { engineVersion: "0.9.0" } : {}),
    policyVersion: 1,
    lines: [
      {
        variantId: VARIANT,
        name: "Tea",
        sku: "TEA",
        locationId: LOC,
        qty: "2",
        unitPriceMinor: 500,
        priceSource: "list",
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 1000,
      },
    ],
    tenders: [{ id: uuidv7(), kind: "cash", amountMinor: 1000 }],
    subtotalMinor: 1000,
    discountMinor: 0,
    feeMinor: 0,
    taxMinor: 0,
    totalMinor: 1000,
    cashRoundingMinor: 0,
    payableMinor: 1000,
    meta: meta(k.t),
  });
  await tx((x) => completeSale(x, ports, k.t, cmd), k.tenant);
  return cmd;
}

interface Page {
  items: {
    id: string;
    status: string;
    flags: string[];
    lines?: unknown[];
    tenders?: unknown[];
    returns?: unknown[];
    void?: unknown;
  }[];
  nextCursor: string | null;
}

let k: Till;
const ids: string[] = [];
beforeAll(async () => {
  k = await till();
  for (let i = 0; i < 5; i++) ids.push((await sell(k)).id);
  const flagged = await sell(k, { flags: true });
  ids.push(flagged.id);
  // sale[0] voided, sale[1] partly returned
  await tx((x) =>
    voidSale(
      x,
      ports,
      k.t,
      VoidSaleSchema.parse({
        id: uuidv7(),
        saleId: ids[0],
        shiftId: k.shiftId,
        operatorId: OPERATOR,
        occurredAt: iso(),
        reason: "Wrong item",
        meta: meta(k.t),
      }),
    ),
  );
  await tx((x) =>
    completeReturn(
      x,
      ports,
      k.t,
      CompleteReturnSchema.parse({
        id: uuidv7(),
        saleId: ids[1],
        shiftId: k.shiftId,
        operatorId: OPERATOR,
        returnNo: k.nextNo(),
        currency: "USD",
        businessDate: TODAY,
        occurredAt: iso(),
        reason: "Damaged",
        lines: [
          {
            saleLine: 0,
            variantId: VARIANT,
            name: "Tea",
            sku: "TEA",
            locationId: LOC,
            qty: "1",
            refundMinor: 500,
            taxMinor: 0,
            disposition: "restock",
          },
        ],
        tenders: [{ id: uuidv7(), kind: "cash", amountMinor: 500 }],
        totalMinor: 500,
        meta: meta(k.t),
      }),
    ),
  );
});

describe("sales reads", () => {
  it("needs sales:read (404 otherwise, before validation)", async () => {
    role = "nobody";
    expect((await get("/sales")).status).toBe(404);
    expect((await get("/sales?limit=banana")).status).toBe(404);
    expect((await get(`/shifts/${k.shiftId}`)).status).toBe(404);
    role = "viewer";
    expect((await get("/sales?limit=banana")).status).toBe(422);
  });

  it("pages newest first by keyset without gaps or repeats", async () => {
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: Page = await json(
        await get(`/sales?shiftId=${k.shiftId}&limit=2${after === null ? "" : `&after=${after}`}`),
      );
      seen.push(...page.items.map((s) => s.id));
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("filters by status, review flags and shift", async () => {
    const voided: Page = await json(await get(`/sales?status=voided&shiftId=${k.shiftId}`));
    expect(voided.items.map((s) => s.id)).toEqual([ids[0]]);
    const flagged: Page = await json(await get(`/sales?flagged=true&shiftId=${k.shiftId}`));
    expect(flagged.items.map((s) => s.id)).toEqual([ids[5]]);
    expect(flagged.items[0]?.flags).toEqual(["stale_price"]);
    const byFlag: Page = await json(await get("/sales?flag=stale_price"));
    expect(byFlag.items.length).toBeGreaterThanOrEqual(1);
    const none: Page = await json(await get(`/sales?from=2999-01-01&shiftId=${k.shiftId}`));
    expect(none.items).toEqual([]);
  });

  it("includes cost a constant number of queries whatever the page size", async () => {
    const cost = async (limit: number) =>
      (
        await countQueries(async () =>
          json<Page>(
            await get(
              `/sales?shiftId=${k.shiftId}&limit=${String(limit)}&include=lines,tenders,returns,void`,
            ),
          ),
        )
      ).count;
    const one = await cost(1);
    const many = await cost(6);
    expect(many).toBe(one);
    expect(many).toBeLessThanOrEqual(7); // list, lines, tenders, returns, return lines, voids
    const page: Page = await json(
      await get(`/sales?shiftId=${k.shiftId}&include=lines,tenders,returns,void`),
    );
    const byId = new Map(page.items.map((s) => [s.id, s]));
    expect(byId.get(ids[0] ?? "")?.void).toMatchObject({ reason: "Wrong item" });
    expect(byId.get(ids[1] ?? "")?.returns).toHaveLength(1);
    expect(byId.get(ids[2] ?? "")?.void).toBeNull();
    expect(byId.get(ids[2] ?? "")?.lines).toHaveLength(1);
    expect(byId.get(ids[2] ?? "")?.tenders).toHaveLength(1);
  });

  it("returns one sale with includes, 404 for unknown, 422 for a bad include", async () => {
    const sale = await json<Page["items"][number]>(
      await get(`/sales/${ids[1] ?? ""}?include=returns,lines`),
    );
    expect(sale.returns).toHaveLength(1);
    expect(sale.lines).toHaveLength(1);
    expect(sale.tenders).toBeUndefined();
    expect((await get(`/sales/${uuidv7()}`)).status).toBe(404);
    expect((await get(`/sales/${ids[1] ?? ""}?include=secrets`)).status).toBe(422);
    expect((await get(`/sales?include=lines,nope`)).status).toBe(422);
  });

  it("a branch-scoped member sees only their branches; another tenant sees nothing", async () => {
    scope = [OTHER_BRANCH];
    expect((await json<Page>(await get("/sales"))).items).toEqual([]);
    expect((await get(`/sales/${ids[1] ?? ""}`)).status).toBe(404);
    expect((await get(`/shifts/${k.shiftId}`)).status).toBe(404);
    scope = [BRANCH];
    expect((await get(`/sales/${ids[1] ?? ""}`)).status).toBe(200);
    scope = [];
    expect((await get("/sales")).status).toBe(404);
    scope = [OTHER_BRANCH, BRANCH];
    expect((await json<Page>(await get(`/sales?shiftId=${k.shiftId}`))).items).toHaveLength(6);
    role = "nobody";
    scope = [BRANCH];
    expect((await get("/sales")).status).toBe(404);
    role = "viewer";
    scope = "all";
    tenantId = OTHER_TENANT;
    expect((await json<Page>(await get("/sales"))).items).toEqual([]);
    expect((await get(`/sales/${ids[1] ?? ""}`)).status).toBe(404);
    tenantId = T;
  });

  it("lists shifts and serves the Z-report only once the shift is closed", async () => {
    const open = await json<{ status: string; zReport: unknown }>(
      await get(`/shifts/${k.shiftId}`),
    );
    expect(open).toMatchObject({ status: "open", zReport: null });
    expect((await get(`/shifts/${k.shiftId}/z-report`)).status).toBe(404);
    await tx((x) =>
      closeShift(
        x,
        ports,
        k.t,
        CloseShiftSchema.parse({
          id: k.shiftId,
          operatorId: OPERATOR,
          closedAt: iso(),
          countedCashMinor: 3500,
          meta: meta(k.t),
        }),
      ),
    );
    const z = await json<{ sales: { count: number }; cash: { expectedMinor: number } }>(
      await get(`/shifts/${k.shiftId}/z-report`),
    );
    expect(z.sales.count).toBe(6);
    // cash sales 6 x 1000 - void 1000 - refund 500
    expect(z.cash.expectedMinor).toBe(4500);
    const shifts = await json<{
      items: { id: string; status: string; overShortMinor: number }[];
      nextCursor: string | null;
    }>(await get(`/shifts?status=closed&branchId=${BRANCH}`));
    expect(shifts.items.find((s) => s.id === k.shiftId)).toMatchObject({
      status: "closed",
      overShortMinor: -1000,
    });
    expect((await get(`/shifts/${uuidv7()}`)).status).toBe(404);
  });
});
