import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listNearExpiry } from "../src/application/expiry.ts";
import { createInventoryModule, recordMovements } from "../src/index.ts";

import type { MovementInput } from "../src/index.ts";
import type { AppEnv, CommandContext } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const DAY = 86_400_000;

const T = uuidv7();
const OTHER = uuidv7();
const USER = uuidv7();
const locations = new Set<string>();

const inventoryModule = createInventoryModule({
  locationExists: (_tx, _tenant, id) => Promise.resolve(locations.has(id)),
});
const matrix = matrixFromRows(createCatalog(inventoryModule.permissions), [
  { role: "reader", permission: "expiry:read" },
  { role: "writer", permission: "expiry:read" },
  { role: "writer", permission: "expiry:writeoff" },
  { role: "counter", permission: "counts:read" },
]);

let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let app: OpenAPIHono<AppEnv>;
let role = "reader";

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "inventory", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"), { max: 20 });
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
    c.set("requestId", "req-expiry-0001");
    c.set("auth", {
      kind: "user",
      userId: USER,
      sessionId: "01900000-0000-7000-8000-0000000000cc",
      tenantId: T,
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
    return c.json(p, p.status as 404);
  });
  inventoryModule.routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });
});
afterAll(async () => {
  await drop();
});

const ctx = (): CommandContext => ({
  tenant: { tenantId: T, userId: USER, requestId: "req-expiry-0001" },
  userId: USER,
  requestId: "req-expiry-0001",
  now: new Date(),
  ids: { uuidv7 },
});

async function call(
  who: string,
  method: string,
  path: string,
  body?: unknown,
  idem = `k-${uuidv7()}`,
): Promise<Response> {
  role = who;
  return app.request(`/v1/inventory${path}`, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": idem },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json<R>(res: Response, status: number): Promise<R> {
  if (res.status !== status) throw new Error(`${String(res.status)}: ${await res.text()}`);
  return (await res.json()) as R;
}

/** A calendar date `n` days from today, UTC. */
const day = (n: number): string => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const ago = (n: number): Date => new Date(Date.now() - n * DAY);

const newLocation = (): string => {
  const id = uuidv7();
  locations.add(id);
  return id;
};

async function variant(tracks = true): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `insert into inventory.variant_facts (tenant_id, variant_id, tracks_batches, archived, source_time, category_ids)
     values ($1, $2, $3, false, now(), '{}'::uuid[])`,
    [T, id, tracks],
  );
  return id;
}

async function batch(
  variantId: string,
  expiresOn: string | null,
  costMinor = 300,
): Promise<string> {
  const id = uuidv7();
  await admin.query(
    `insert into inventory.batches (tenant_id, id, variant_id, lot_code, expires_on, currency, unit_cost_minor, received_at)
     values ($1, $2, $3, null, $4, 'USD', $5, now())`,
    [T, id, variantId, expiresOn, costMinor],
  );
  return id;
}

/** One ledger document, as the module writes it (same path as sales and receipts). */
async function move(
  loc: string,
  variantId: string,
  batchId: string,
  qty: string,
  reason: MovementInput["reason"],
  occurredAt: Date,
  cost = 300,
): Promise<void> {
  await withTenantTx(pool, { tenantId: T, userId: USER, requestId: "req-expiry-0001" }, (tx) =>
    recordMovements(tx, ctx(), { type: `doc_${reason}`, id: uuidv7(), occurredAt }, [
      {
        locationId: loc,
        variantId,
        batchId,
        qty,
        reason,
        sourceLine: 1,
        unitCostMinor: cost,
      },
    ]),
  );
}

async function onHand(loc: string, batchId: string): Promise<number> {
  const r = await admin.query<{ qty: string }>(
    `select coalesce(sum(qty), 0)::text as qty from inventory.stock_balances
      where tenant_id = $1 and location_id = $2 and batch_id = $3`,
    [T, loc, batchId],
  );
  return Number(r.rows[0]?.qty ?? "0");
}

interface NearExpiryView {
  asOf: string;
  days: number;
  items: {
    batchId: string;
    daysLeft: number;
    qtyOnHand: string;
    valueMinor: number;
    locationId: string;
  }[];
  nextCursor: string | null;
}

describe("permissions: unauthorized is 404, before validation", () => {
  it("expiry reads and writes need their own permission", async () => {
    const loc = newLocation();
    expect((await call("counter", "GET", `/expiry/near-expiry?locationId=${loc}`)).status).toBe(
      404,
    );
    expect(
      (await call("reader", "GET", `/expiry/fefo-report?from=${day(-10)}&to=${day(0)}`)).status,
    ).toBe(200);
    expect(
      (
        await call("reader", "POST", "/expiry/writeoffs", {
          locationId: loc,
          lines: [{ variantId: uuidv7(), batchId: uuidv7(), qty: "1" }],
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("reader", "POST", "/expiry/markdowns", { locationId: loc, batchId: uuidv7() }))
        .status,
    ).toBe(404);
  });
});

describe("near-expiry list", () => {
  it("lists positive stock expiring within the horizon, per location, valued at cost, keyset paged", async () => {
    const loc = newLocation();
    const other = newLocation();
    const v = await variant();
    const soon = await batch(v, day(5), 300);
    const mid = await batch(v, day(20), 100);
    const late = await batch(v, day(60), 100);
    const empty = await batch(v, day(3), 100);
    const expired = await batch(v, day(-2), 50);
    const elsewhere = await batch(v, day(4), 300);
    await move(loc, v, soon, "4", "receive", ago(30), 300);
    await move(loc, v, mid, "9", "receive", ago(30), 100);
    await move(loc, v, late, "2", "receive", ago(30), 100);
    await move(loc, v, empty, "1", "receive", ago(30), 100);
    await move(loc, v, empty, "-1", "adjust", ago(29), 100);
    await move(loc, v, expired, "1", "receive", ago(30), 50);
    await move(other, v, elsewhere, "7", "receive", ago(30), 300);

    const page1 = await json<NearExpiryView>(
      await call("reader", "GET", `/expiry/near-expiry?locationId=${loc}&days=30&limit=2`),
      200,
    );
    // Expired first (earliest expiry), then soon, then mid. Late (60 days) and the empty batch are out.
    expect(page1.items.map((i) => i.batchId)).toEqual([expired, soon]);
    expect(page1.items[0]).toMatchObject({ daysLeft: -2, qtyOnHand: "1", valueMinor: 50 });
    expect(page1.items[1]).toMatchObject({ daysLeft: 5, qtyOnHand: "4", valueMinor: 1200 });
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await json<NearExpiryView>(
      await call(
        "reader",
        "GET",
        `/expiry/near-expiry?locationId=${loc}&days=30&limit=2&after=${encodeURIComponent(page1.nextCursor ?? "")}`,
      ),
      200,
    );
    expect(page2.items.map((i) => i.batchId)).toEqual([mid]);
    expect(page2.items[0]).toMatchObject({ qtyOnHand: "9", valueMinor: 900 });
    expect(page2.nextCursor).toBeNull();

    const narrow = await json<NearExpiryView>(
      await call("reader", "GET", `/expiry/near-expiry?locationId=${loc}&days=10`),
      200,
    );
    expect(narrow.items.map((i) => i.batchId)).toEqual([expired, soon]);

    const all = await json<NearExpiryView>(
      await call("reader", "GET", `/expiry/near-expiry?days=365&limit=200`),
      200,
    );
    const mine = all.items.filter((i) => i.batchId === elsewhere);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.locationId).toBe(other);
  });

  it("a malformed cursor is a 422, and another tenant sees none of these rows", async () => {
    expect((await call("reader", "GET", "/expiry/near-expiry?after=garbage")).status).toBe(422);
    const seen = await withTenantTx(pool, { tenantId: OTHER, userId: USER, requestId: "r" }, (tx) =>
      listNearExpiry(tx, OTHER, { days: 365 }, Date.now()),
    );
    expect(seen.items).toEqual([]);
  });
});

describe("write-off through the ledger", () => {
  it("writes off expiring stock as a writeoff adjustment, with movement, audit and outbox; a replay changes nothing", async () => {
    const loc = newLocation();
    const v = await variant();
    const b = await batch(v, day(2), 250);
    await move(loc, v, b, "10", "receive", ago(20), 250);

    const body = {
      locationId: loc,
      note: "spoiled",
      lines: [{ variantId: v, batchId: b, qty: "4" }],
    };
    const key = `k-${uuidv7()}`;
    const res = await json<{ id: string; valueMinor: number; currency: string }>(
      await call("writer", "POST", "/expiry/writeoffs", body, key),
      201,
    );
    expect(res).toMatchObject({ valueMinor: 1000, currency: "USD" });
    expect(await onHand(loc, b)).toBe(6);

    const movement = await admin.query<{ n: string }>(
      `select count(*)::text as n from inventory.stock_movements
        where tenant_id = $1 and batch_id = $2 and reason = 'writeoff' and qty = -4`,
      [T, b],
    );
    expect(movement.rows[0]?.n).toBe("1");
    const adj = await admin.query<{ reason: string; value_minor: string }>(
      `select reason, value_minor::text from inventory.adjustments where tenant_id = $1 and id = $2`,
      [T, res.id],
    );
    expect(adj.rows[0]).toEqual({ reason: "writeoff", value_minor: "1000" });
    const audit = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit.audit_log where tenant_id = $1 and action = 'inventory.expiry.written_off'
         and entity_id = $2`,
      [T, res.id],
    );
    expect(audit.rows[0]?.n).toBe("1");
    const movementEvents = await admin.query<{ n: string }>(
      `select count(*)::text as n from infra.outbox where tenant_id = $1 and type = 'inventory.movement.recorded'
         and payload->'data'->>'variantId' = $2 and payload->'data'->>'sourceType' = 'adjustment'`,
      [T, v],
    );
    expect(movementEvents.rows[0]?.n).toBe("1");

    // Replay with the same idempotency key: the stored response, no second write-off.
    const replay = await call("writer", "POST", "/expiry/writeoffs", body, key);
    expect(replay.status).toBe(201);
    expect(await onHand(loc, b)).toBe(6);
  });

  it("refuses: more than available, stock that is not expiring soon, untracked variants, unknown batches", async () => {
    const loc = newLocation();
    const v = await variant();
    const soon = await batch(v, day(3), 100);
    const far = await batch(v, day(40), 100);
    await move(loc, v, soon, "5", "receive", ago(20), 100);
    await move(loc, v, far, "5", "receive", ago(20), 100);
    const untracked = await variant(false);
    const line = (variantId: string, batchId: string, qty: string) => ({
      locationId: loc,
      lines: [{ variantId, batchId, qty }],
    });
    expect((await call("writer", "POST", "/expiry/writeoffs", line(v, soon, "9"))).status).toBe(
      409,
    );
    expect((await call("writer", "POST", "/expiry/writeoffs", line(v, far, "1"))).status).toBe(422);
    expect(
      (await call("writer", "POST", "/expiry/writeoffs", line(untracked, uuidv7(), "1"))).status,
    ).toBe(422);
    expect((await call("writer", "POST", "/expiry/writeoffs", line(v, uuidv7(), "1"))).status).toBe(
      422,
    );
    expect(await onHand(loc, soon)).toBe(5);
  });

  it("FEFO: a later batch is refused while an earlier one still holds stock; the earlier one is written off first", async () => {
    const loc = newLocation();
    const v = await variant();
    const e1 = await batch(v, day(3), 100);
    const e2 = await batch(v, day(5), 100);
    await move(loc, v, e1, "5", "receive", ago(20), 100);
    await move(loc, v, e2, "5", "receive", ago(20), 100);

    const blocked = await call("writer", "POST", "/expiry/writeoffs", {
      locationId: loc,
      lines: [{ variantId: v, batchId: e2, qty: "2" }],
    });
    expect(blocked.status).toBe(409);

    // One document: the earlier batch goes fully, then the later one is allowed.
    const ok = await call("writer", "POST", "/expiry/writeoffs", {
      locationId: loc,
      lines: [
        { variantId: v, batchId: e1, qty: "5" },
        { variantId: v, batchId: e2, qty: "1" },
      ],
    });
    expect(ok.status).toBe(201);
    expect(await onHand(loc, e1)).toBe(0);
    expect(await onHand(loc, e2)).toBe(4);
  });

  it("an expired batch can be written off (the FEFO guard only looks at batches that have not expired)", async () => {
    const loc = newLocation();
    const v = await variant();
    const old = await batch(v, day(-3), 100);
    await move(loc, v, old, "3", "receive", ago(20), 100);
    expect(
      (
        await call("writer", "POST", "/expiry/writeoffs", {
          locationId: loc,
          lines: [{ variantId: v, batchId: old, qty: "3" }],
        })
      ).status,
    ).toBe(201);
    expect(await onHand(loc, old)).toBe(0);
  });
});

describe("markdown suggestion: outbox draft", () => {
  it("records the draft as inventory.expiry.markdown_suggested@v1 with audit; refuses expired and no-op batches", async () => {
    const loc = newLocation();
    const v = await variant();
    const b = await batch(v, day(6), 300);
    await move(loc, v, b, "20", "receive", ago(20), 300);
    const res = await json<{ percent: number; state: string; daysLeft: number }>(
      await call("writer", "POST", "/expiry/markdowns", { locationId: loc, batchId: b }),
      201,
    );
    // Band 30 (7 days or fewer), no sales in the window: factor 1.5 -> 45.
    expect(res).toMatchObject({ percent: 45, state: "draft", daysLeft: 6 });
    const ev = await admin.query<{ version: number; payload: { data: { percent: number } } }>(
      `select version, payload from infra.outbox where tenant_id = $1 and type = 'inventory.expiry.markdown_suggested'
         and payload->'data'->>'batchId' = $2`,
      [T, b],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]?.version).toBe(1);
    expect(ev.rows[0]?.payload.data.percent).toBe(45);
    const audit = await admin.query<{ n: string }>(
      `select count(*)::text as n from audit.audit_log where tenant_id = $1 and action = 'inventory.expiry.markdown_suggested'
         and entity_id = $2`,
      [T, b],
    );
    expect(audit.rows[0]?.n).toBe("1");

    const expired = await batch(v, day(-1), 300);
    await move(loc, v, expired, "2", "receive", ago(20), 300);
    expect(
      (await call("writer", "POST", "/expiry/markdowns", { locationId: loc, batchId: expired }))
        .status,
    ).toBe(409);
  });

  it("no markdown when the stock sells through before it expires (rule 0%)", async () => {
    const loc = newLocation();
    const v = await variant();
    const slow = await batch(v, day(60), 100);
    const b = await batch(v, day(6), 100);
    await move(loc, v, slow, "200", "receive", ago(40), 100);
    await move(loc, v, b, "20", "receive", ago(40), 100);
    // 100 sold in the window: 3.57 a day; 20 ahead covers ~5.6 days, under the 6 days left: factor 0.
    await move(loc, v, slow, "-100", "sale", ago(5), 100);
    expect(
      (await call("writer", "POST", "/expiry/markdowns", { locationId: loc, batchId: b })).status,
    ).toBe(409);
  });
});

describe("FEFO compliance report", () => {
  it("counts per variant: a violation, a compliant sale, an earlier batch that had expired, and a backdated balance", async () => {
    const loc = newLocation();
    const violating = await variant();
    const compliant = await variant();
    const oldExpired = await variant();
    const backdated = await variant();
    const earlyV = await batch(violating, day(20), 100);
    const lateV = await batch(violating, day(60), 100);
    const earlyC = await batch(compliant, day(20), 100);
    const lateC = await batch(compliant, day(60), 100);
    const gone = await batch(oldExpired, day(-15), 100);
    const fresh = await batch(oldExpired, day(20), 100);
    const earlyB = await batch(backdated, day(20), 100);
    const lateB = await batch(backdated, day(60), 100);
    for (const [v, a, b] of [
      [violating, earlyV, lateV],
      [compliant, earlyC, lateC],
      [oldExpired, gone, fresh],
      [backdated, earlyB, lateB],
    ] as const) {
      await move(loc, v, a, "10", "receive", ago(40), 100);
      await move(loc, v, b, "10", "receive", ago(40), 100);
    }
    // Violation: 3 from the later batch while the earlier one holds 10.
    await move(loc, violating, lateV, "-3", "sale", ago(10), 100);
    // Compliant: from the earliest batch.
    await move(loc, compliant, earlyC, "-3", "sale", ago(10), 100);
    // Earlier batch expired on the sale date: skipped, not a violation.
    await move(loc, oldExpired, fresh, "-3", "sale", ago(10), 100);
    // Backdated: the later sale of the earlier batch happens after; at the earlier sale, it held 10.
    await move(loc, backdated, lateB, "-3", "sale", ago(10), 100);
    await move(loc, backdated, earlyB, "-10", "sale", ago(5), 100);

    const report = await json<{
      items: { variantId: string; outflows: number; violations: number; violatedQty: string }[];
    }>(
      await call("reader", "GET", `/expiry/fefo-report?from=${day(-60)}&to=${day(0)}&limit=200`),
      200,
    );
    const row = (v: string) => report.items.find((i) => i.variantId === v);
    expect(row(violating)).toEqual({
      variantId: violating,
      outflows: 1,
      violations: 1,
      violatedQty: "3",
    });
    expect(row(compliant)).toEqual({
      variantId: compliant,
      outflows: 1,
      violations: 0,
      violatedQty: "0",
    });
    expect(row(oldExpired)).toEqual({
      variantId: oldExpired,
      outflows: 1,
      violations: 0,
      violatedQty: "0",
    });
    expect(row(backdated)).toEqual({
      variantId: backdated,
      outflows: 2,
      violations: 1,
      violatedQty: "3",
    });
  });

  it("rejects an inverted window and one longer than 92 days", async () => {
    expect(
      (await call("reader", "GET", `/expiry/fefo-report?from=${day(0)}&to=${day(-1)}`)).status,
    ).toBe(422);
    expect(
      (await call("reader", "GET", `/expiry/fefo-report?from=${day(-200)}&to=${day(0)}`)).status,
    ).toBe(422);
  });
});

describe("query plans: the new reads use their indexes (seqscan off)", () => {
  const plan = async (sql: string, params: unknown[]): Promise<string> => {
    const client = await admin.connect();
    try {
      await client.query("begin");
      await client.query("set local enable_seqscan = off");
      await client.query("select set_config('app.tenant_id', $1, true)", [T]);
      const r = await client.query<{ "QUERY PLAN": string }>(`explain ${sql}`, params);
      await client.query("rollback");
      return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
    } finally {
      client.release();
    }
  };

  it("near-expiry: batches by expiry range, then balances by variant", async () => {
    const text = await plan(
      `select b.id, s.location_id from inventory.batches b
         join inventory.stock_balances s on s.tenant_id = b.tenant_id and s.variant_id = b.variant_id and s.batch_id = b.id
        where b.tenant_id = $1 and b.expires_on is not null and b.expires_on <= $2::date and s.qty > 0
        order by b.expires_on, b.id, s.location_id limit 51`,
      [T, day(30)],
    );
    expect(text).toMatch(/Index/);
    expect(text).not.toMatch(/Seq Scan on batches/);
  });

  it("FEFO report: consumption rows by tenant and time, and the balances of the pairs", async () => {
    const outflows = await plan(
      `select m.location_id from inventory.stock_movements m
        where m.tenant_id = $1 and m.occurred_at >= $2 and m.occurred_at < $3
          and m.reason = any($4::text[]) and m.qty < 0 and m.batch_id is not null`,
      [T, ago(60), ago(-1), ["sale", "transfer_out"]],
    );
    expect(outflows).toMatch(/stock_movements|Index/);
    expect(outflows).not.toMatch(/Seq Scan/);
    const balances = await plan(
      `with p as (select * from unnest($2::uuid[], $3::uuid[]) as p(location_id, variant_id))
       select s.batch_id from inventory.stock_balances s
         join p on p.location_id = s.location_id and p.variant_id = s.variant_id
        where s.tenant_id = $1`,
      [T, [uuidv7()], [uuidv7()]],
    );
    expect(balances).toMatch(/stock_balances_pkey|stock_balances_tenant_variant_idx/);
  });
});
