import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, rlsSql, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInventoryModule, recordMovements } from "../src/index.ts";

import type { MovementInput } from "../src/index.ts";
import type { AppEnv, CommandContext } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");

const T = uuidv7();
const OTHER = uuidv7();
const USER = uuidv7();
const locations = new Set<string>();

const inventoryModule = createInventoryModule({
  locationExists: (_tx, _tenant, id) => Promise.resolve(locations.has(id)),
});
const matrix = matrixFromRows(createCatalog(inventoryModule.permissions), [
  { role: "counter", permission: "counts:read" },
  { role: "counter", permission: "counts:write" },
  { role: "reviewer", permission: "counts:read" },
  { role: "reviewer", permission: "counts:approve" },
  { role: "reader", permission: "counts:read" },
]);

let pool: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let app: OpenAPIHono<AppEnv>;
let role = "counter";
const actor = USER;
const tenantId = T;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "inventory", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"), { max: 30 });
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
    c.set("requestId", "req-counts-0001");
    c.set("auth", {
      kind: "user",
      userId: actor,
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
    return c.json(p, p.status as 404);
  });
  inventoryModule.routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });
});
afterAll(async () => {
  await drop();
});

const ctx = (t = T, user = USER): CommandContext => ({
  tenant: { tenantId: t, userId: user, requestId: "req-counts-0001" },
  userId: user,
  requestId: "req-counts-0001",
  now: new Date(),
  ids: { uuidv7 },
});

/** One HTTP call as a given role. Mutations get a fresh idempotency key unless one is passed. */
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

const newLocation = (): string => {
  const id = uuidv7();
  locations.add(id);
  return id;
};

/** An untracked variant with a receipt (so its unit cost is known) and a stock level at one location. */
async function untrackedWithStock(
  loc: string,
  qty: string,
  cost = 250,
  categoryIds: string[] = [],
) {
  const variantId = uuidv7();
  await admin.query(
    `insert into inventory.variant_facts (tenant_id, variant_id, tracks_batches, archived, source_time, category_ids)
     values ($1, $2, false, false, now(), $3::uuid[])`,
    [T, variantId, categoryIds],
  );
  const receiptId = uuidv7();
  await admin.query(
    `insert into inventory.receipts (tenant_id, id, location_id, currency, received_at, created_by)
     values ($1, $2, $3, 'USD', now(), $4)`,
    [T, receiptId, loc, USER],
  );
  await movement(loc, variantId, null, qty, "receive", { type: "receipt", id: receiptId }, cost);
  return variantId;
}

/** A batch-tracked variant with one batch holding stock at a location. */
async function batchedWithStock(loc: string, qty: string, cost = 400) {
  const variantId = uuidv7();
  const batchId = uuidv7();
  await admin.query(
    `insert into inventory.variant_facts (tenant_id, variant_id, tracks_batches, archived, source_time)
     values ($1, $2, true, false, now())`,
    [T, variantId],
  );
  await admin.query(
    `insert into inventory.batches (tenant_id, id, variant_id, currency, unit_cost_minor, received_at)
     values ($1, $2, $3, 'USD', $4, now())`,
    [T, batchId, variantId, cost],
  );
  await movement(loc, variantId, batchId, qty, "receive", { type: "receipt", id: uuidv7() }, cost);
  return { variantId, batchId };
}

/** One ledger document. Sales may carry an occurredAt in the past (an offline sale synced later). */
async function movement(
  loc: string,
  variantId: string,
  batchId: string | null,
  qty: string,
  reason: MovementInput["reason"],
  source: { type: string; id: string },
  cost: number | null = null,
  occurredAt = new Date(),
): Promise<void> {
  await withTenantTx(pool, { tenantId: T, userId: USER, requestId: "req-counts-0001" }, (tx) =>
    recordMovements(tx, ctx(), { type: source.type, id: source.id, occurredAt }, [
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

async function onHand(loc: string, variantId: string, batchId: string | null): Promise<string> {
  const r = await admin.query<{ qty: string }>(
    `select qty::text as qty from inventory.stock_balances
      where tenant_id = $1 and location_id = $2 and variant_id = $3
        and batch_id = coalesce($4::uuid, '00000000-0000-0000-0000-000000000000')`,
    [T, loc, variantId, batchId],
  );
  // numeric(18,4) text is "13.0000": compare on the value, not the text.
  return String(Number(r.rows[0]?.qty ?? "0"));
}

interface Header {
  id: string;
  status: string;
  version: number;
  blind: boolean;
  lineCount: number;
  countedLineCount: number;
}
interface Detail {
  count: Header;
  lines: {
    variantId: string;
    batchId: string | null;
    countedQty: string | null;
    expectedQty: string | null;
    closeQty: string | null;
  }[];
  nextCursor: string | null;
}
interface Variance {
  count: Header;
  lines: {
    variantId: string;
    batchId: string | null;
    countedQty: string | null;
    expectedQty: string | null;
    varianceQty: string | null;
    valueMinor: number | null;
  }[];
  totals: { shortValueMinor: number | null; overValueMinor: number | null; unvaluedLines: number };
}

const scan = (variantId: string, qty: string, batchId: string | null = null) => ({
  id: uuidv7(),
  variantId,
  batchId,
  qty,
  scannedAt: new Date().toISOString(),
});

describe("permissions and surfaces", () => {
  it("unauthorized callers get 404 on every count route (no role, reader creating)", async () => {
    const loc = newLocation();
    const body = {
      locationId: loc,
      kind: "full",
      blind: false,
      mode: "live",
      currency: "USD",
    };
    expect((await call("reader", "POST", "/counts", body)).status).toBe(404);
    expect((await call("nobody", "GET", "/counts")).status).toBe(404);
  });

  it("only counts:approve can approve; the counter gets 404", async () => {
    const loc = newLocation();
    await untrackedWithStock(loc, "2");
    const created = await json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "full",
        blind: false,
        mode: "live",
        currency: "USD",
      }),
      201,
    );
    expect(
      (await call("counter", "POST", `/counts/${created.id}/approve`, { version: 1 })).status,
    ).toBe(404);
  });

  it("rejects an ABC scope (no source yet) and a cycle count with no scope", async () => {
    const loc = newLocation();
    const res = await call("counter", "POST", "/counts", {
      locationId: loc,
      kind: "cycle",
      scope: { abcClass: "A" },
      blind: false,
      mode: "live",
      currency: "USD",
    });
    expect(res.status).toBe(422);
    const none = await call("counter", "POST", "/counts", {
      locationId: loc,
      kind: "cycle",
      blind: false,
      mode: "live",
      currency: "USD",
    });
    expect(none.status).toBe(422);
  });
});

describe("count flow over HTTP", () => {
  it("snapshot, scans (idempotent), close, variance, recount, approve posts the variance", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10", 250);
    const b = await batchedWithStock(loc, "4", 400);

    const created = await json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "full",
        blind: false,
        mode: "live",
        currency: "USD",
      }),
      201,
    );
    expect(created.status).toBe("draft");
    expect(created.lineCount).toBe(2);
    await json<Header>(
      await call("counter", "POST", `/counts/${created.id}/open`, { version: 1 }),
      200,
    );

    // Counted: 7 of A (3 missing), 4 of B (ok). Scanned in two devices' batches, one scan replayed.
    const s1 = scan(a, "3");
    const s2 = scan(a, "4");
    const sb = scan(b.variantId, "4", b.batchId);
    const first = await json<{ accepted: number; duplicates: number }>(
      await call("counter", "POST", `/counts/${created.id}/scans`, { scans: [s1, s2, sb] }),
      200,
    );
    expect(first).toEqual({ accepted: 3, duplicates: 0 });
    const replay = await json<{ accepted: number; duplicates: number }>(
      await call("counter", "POST", `/counts/${created.id}/scans`, { scans: [s1] }),
      200,
    );
    expect(replay).toEqual({ accepted: 0, duplicates: 1 });

    const closed = await json<Header>(
      await call("counter", "POST", `/counts/${created.id}/close`, { version: 2 }),
      200,
    );
    expect(closed.status).toBe("review");
    expect(closed.countedLineCount).toBe(2);

    const variance = await json<Variance>(
      await call("reviewer", "GET", `/counts/${created.id}/variance`),
      200,
    );
    const va = variance.lines.find((l) => l.variantId === a);
    expect(va?.varianceQty).toBe("-3");
    expect(va?.valueMinor).toBe(-750);
    expect(variance.totals.shortValueMinor).toBe(-750);

    // Review sends line A back for a recount: the count reopens, the line's counted quantity is cleared. Requesting a
    // recount is counts:write (the reviewer holds counts:approve only, so it gets 404 here by design).
    const reopened = await json<Header>(
      await call("counter", "POST", `/counts/${created.id}/recounts`, {
        version: 3,
        lines: [{ variantId: a }],
      }),
      200,
    );
    expect(reopened.status).toBe("open");
    await json<{ accepted: number }>(
      await call("counter", "POST", `/counts/${created.id}/scans`, { scans: [scan(a, "7")] }),
      200,
    );
    await json<Header>(
      await call("counter", "POST", `/counts/${created.id}/close`, { version: 4 }),
      200,
    );

    const approved = await json<Header>(
      await call("reviewer", "POST", `/counts/${created.id}/approve`, { version: 5 }),
      200,
    );
    expect(approved.status).toBe("approved");
    expect(await onHand(loc, a, null)).toBe("7");
    expect(await onHand(loc, b.variantId, b.batchId)).toBe("4");

    const posted = await admin.query<{ qty: string; reason: string }>(
      `select qty::text as qty, reason from inventory.stock_movements
        where tenant_id = $1 and source_type = 'stock_count' and source_id = $2`,
      [T, created.id],
    );
    expect(posted.rows).toEqual([{ qty: "-3.0000", reason: "count_variance" }]);
    const events = await admin.query<{ n: string }>(
      `select count(*)::text as n from infra.outbox where tenant_id = $1 and type = 'inventory.count.approved'`,
      [T],
    );
    expect(events.rows[0]?.n).toBe("1");
  });

  it("a second active count at one location is refused", async () => {
    const loc = newLocation();
    await untrackedWithStock(loc, "1");
    const body = { locationId: loc, kind: "full", blind: false, mode: "live", currency: "USD" };
    expect((await call("counter", "POST", "/counts", body)).status).toBe(201);
    expect((await call("counter", "POST", "/counts", body)).status).toBe(409);
  });

  it("scans are refused while the count is still a draft", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "1");
    const created = await json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "full",
        blind: false,
        mode: "live",
        currency: "USD",
      }),
      201,
    );
    expect(
      (await call("counter", "POST", `/counts/${created.id}/scans`, { scans: [scan(a, "1")] }))
        .status,
    ).toBe(409);
  });

  it("a scan of a variant outside a cycle count's scope is refused; in scope it adds a found line", async () => {
    const loc = newLocation();
    const cat = uuidv7();
    const inScope = await untrackedWithStock(loc, "5", 100, [cat]);
    const outOfScope = await untrackedWithStock(loc, "5", 100, []);
    const created = await json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "cycle",
        scope: { categoryIds: [cat] },
        blind: false,
        mode: "live",
        currency: "USD",
      }),
      201,
    );
    expect(created.lineCount).toBe(1);
    await call("counter", "POST", `/counts/${created.id}/open`, { version: 1 });
    expect(
      (
        await call("counter", "POST", `/counts/${created.id}/scans`, {
          scans: [scan(outOfScope, "5")],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("counter", "POST", `/counts/${created.id}/scans`, {
          scans: [scan(inScope, "5")],
        })
      ).status,
    ).toBe(200);
  });

  it("blind counts hide expected quantities from the counter until the reviewer sees them", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "9", 100);
    const created = await json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "full",
        blind: true,
        mode: "live",
        currency: "USD",
      }),
      201,
    );
    await call("counter", "POST", `/counts/${created.id}/open`, { version: 1 });
    const hidden = await json<Detail>(await call("counter", "GET", `/counts/${created.id}`), 200);
    expect(hidden.lines.find((l) => l.variantId === a)?.expectedQty).toBeNull();
    const seen = await json<Detail>(await call("reviewer", "GET", `/counts/${created.id}`), 200);
    expect(seen.lines.find((l) => l.variantId === a)?.expectedQty).toBe("9");
    // Variance is not available before close, for anyone.
    expect((await call("reviewer", "GET", `/counts/${created.id}/variance`)).status).toBe(409);
  });

  it("a frozen count refuses approval when stock moved during the window; a live count does not", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10", 100);
    const frozen = await json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "full",
        blind: false,
        mode: "frozen",
        currency: "USD",
      }),
      201,
    );
    await call("counter", "POST", `/counts/${frozen.id}/open`, { version: 1 });
    await movement(loc, a, null, "-1", "sale", { type: "sale", id: uuidv7() }, 100);
    await call("counter", "POST", `/counts/${frozen.id}/scans`, { scans: [scan(a, "9")] });
    await call("counter", "POST", `/counts/${frozen.id}/close`, { version: 2 });
    const refused = await call("reviewer", "POST", `/counts/${frozen.id}/approve`, { version: 3 });
    expect(refused.status).toBe(409);
    const cancelled = await json<Header>(
      await call("counter", "POST", `/counts/${frozen.id}/cancel`, { version: 3 }),
      200,
    );
    expect(cancelled.status).toBe("cancelled");
  });

  it("a cancelled count frees the location for a new count", async () => {
    const loc = newLocation();
    await untrackedWithStock(loc, "1");
    const body = { locationId: loc, kind: "full", blind: false, mode: "live", currency: "USD" };
    const first = await json<Header>(await call("counter", "POST", "/counts", body), 201);
    await json<Header>(
      await call("counter", "POST", `/counts/${first.id}/cancel`, { version: 1 }),
      200,
    );
    expect((await call("counter", "POST", "/counts", body)).status).toBe(201);
  });
});

describe("simulation: counting while sales continue", () => {
  it("live variances are exact when sales race the snapshot and the close, including a backdated offline sale", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "20", 100);
    const b = await batchedWithStock(loc, "15", 200);

    // Sales run while the count is created and counted; one is an offline sale from two days ago, synced mid-count.
    const sales = [
      movement(loc, a, null, "-2", "sale", { type: "sale", id: uuidv7() }, 100),
      movement(loc, b.variantId, b.batchId, "-3", "sale", { type: "sale", id: uuidv7() }, 200),
      movement(
        loc,
        a,
        null,
        "-1",
        "sale",
        { type: "sale", id: uuidv7() },
        100,
        new Date(Date.now() - 2 * 24 * 3600 * 1000),
      ),
    ];
    const [created] = await Promise.all([
      json<Header>(
        await call("counter", "POST", "/counts", {
          locationId: loc,
          kind: "full",
          blind: false,
          mode: "live",
          currency: "USD",
        }),
        201,
      ),
      ...sales,
    ]);
    await call("counter", "POST", `/counts/${created.id}/open`, { version: 1 });
    // Physically on the shelf at close: 20 - 2 - 1 = 17 of A, 15 - 3 = 12 of B.
    await json<{ accepted: number }>(
      await call("counter", "POST", `/counts/${created.id}/scans`, {
        scans: [scan(a, "17"), scan(b.variantId, "12", b.batchId)],
      }),
      200,
    );
    await json<Header>(
      await call("counter", "POST", `/counts/${created.id}/close`, { version: 2 }),
      200,
    );
    const v = await json<Variance>(
      await call("reviewer", "GET", `/counts/${created.id}/variance`),
      200,
    );
    expect(v.lines.every((l) => l.varianceQty === "0")).toBe(true);
    expect(v.totals.shortValueMinor).toBe(0);

    // A sale during review (after the close cut) stays on the ledger: approval books counted, plus that sale.
    await movement(loc, a, null, "-4", "sale", { type: "sale", id: uuidv7() }, 100);
    await json<Header>(
      await call("reviewer", "POST", `/counts/${created.id}/approve`, { version: 3 }),
      200,
    );
    expect(await onHand(loc, a, null)).toBe("13");
    expect(await onHand(loc, b.variantId, b.batchId)).toBe("12");
  });
});

describe("tenant isolation", () => {
  it("another tenant reads nothing, and a line cannot point at another tenant's count", async () => {
    const loc = newLocation();
    await untrackedWithStock(loc, "1");
    const created = await json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "full",
        blind: false,
        mode: "live",
        currency: "USD",
      }),
      201,
    );
    const seen = await withTenantTx(pool, { tenantId: OTHER, userId: USER, requestId: "r" }, (tx) =>
      tx.query("select id from inventory.stock_counts where id = $1", [created.id]),
    );
    expect(seen.rows).toHaveLength(0);
    const none = await pool.connect();
    try {
      const raw = await none.query("select count(*)::int as n from inventory.stock_counts");
      expect(raw.rows[0]).toEqual({ n: 0 });
    } finally {
      none.release();
    }
    await expect(
      admin.query(
        `insert into inventory.count_lines (tenant_id, count_id, variant_id, batch_id, expected_qty)
         values ($1, $2, $3, '00000000-0000-0000-0000-000000000000', 0)`,
        [OTHER, created.id, uuidv7()],
      ),
    ).rejects.toThrow();
  });

  it("the new tables carry forced RLS, and the sql is the rlsSql output", () => {
    for (const t of ["stock_counts", "count_lines", "count_scans"]) {
      expect(rlsSql("inventory", t)).toContain("FORCE ROW LEVEL SECURITY");
    }
  });
});

describe("property: approved variances make the ledger equal the counted quantity", () => {
  it("for random stock, window sales and shelf errors, balance after approval = counted + post-close sales", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 3 }),
        fc.integer({ min: -3, max: 3 }),
        fc.integer({ min: 0, max: 2 }),
        async (start, windowSales, shelfError, postSale) => {
          const loc = newLocation();
          const a = await untrackedWithStock(loc, String(start), 100);
          const created = await json<Header>(
            await call("counter", "POST", "/counts", {
              locationId: loc,
              kind: "full",
              blind: false,
              mode: "live",
              currency: "USD",
            }),
            201,
          );
          await call("counter", "POST", `/counts/${created.id}/open`, { version: 1 });
          for (const s of windowSales) {
            await movement(
              loc,
              a,
              null,
              `-${String(s)}`,
              "sale",
              { type: "sale", id: uuidv7() },
              100,
            );
          }
          const onShelf = start - windowSales.reduce((x, y) => x + y, 0) + shelfError;
          // Counted at close; a scan must be positive, so an empty shelf still counts as one unit here.
          const counted = Math.max(1, onShelf);
          await call("counter", "POST", `/counts/${created.id}/scans`, {
            scans: [scan(a, String(counted))],
          });
          await call("counter", "POST", `/counts/${created.id}/close`, { version: 2 });
          for (let i = 0; i < postSale; i += 1) {
            await movement(loc, a, null, "-1", "sale", { type: "sale", id: uuidv7() }, 100);
          }
          const approved = await call("reviewer", "POST", `/counts/${created.id}/approve`, {
            version: 3,
          });
          expect(approved.status).toBe(200);
          const ledger = Number(await onHand(loc, a, null));
          expect(ledger).toBe(counted - postSale);
        },
      ),
      { numRuns: 4 },
    );
  });
});

describe("count paths: validation, lifecycle, paging, valuation", () => {
  const create = async (loc: string, extra: Record<string, unknown> = {}) =>
    json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "full",
        blind: false,
        mode: "live",
        currency: "USD",
        ...extra,
      }),
      201,
    );

  it("a stale version and a repeated open are refused", async () => {
    const loc = newLocation();
    await untrackedWithStock(loc, "1");
    const c = await create(loc);
    expect((await call("counter", "POST", `/counts/${c.id}/open`, { version: 9 })).status).toBe(
      409,
    );
    await json<Header>(await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 }), 200);
    expect((await call("counter", "POST", `/counts/${c.id}/open`, { version: 2 })).status).toBe(
      409,
    );
  });

  it("recounts: refused on a draft, validated on duplicate and unknown lines, notes kept, open stays open", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "2");
    const c = await create(loc);
    expect(
      (
        await call("counter", "POST", `/counts/${c.id}/recounts`, {
          version: 1,
          lines: [{ variantId: a }],
        })
      ).status,
    ).toBe(409);
    await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 });
    expect(
      (
        await call("counter", "POST", `/counts/${c.id}/recounts`, {
          version: 2,
          lines: [{ variantId: a }, { variantId: a }],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("counter", "POST", `/counts/${c.id}/recounts`, {
          version: 2,
          lines: [{ variantId: uuidv7() }],
        })
      ).status,
    ).toBe(422);
    const r = await json<Header>(
      await call("counter", "POST", `/counts/${c.id}/recounts`, {
        version: 2,
        lines: [{ variantId: a, note: "check the top shelf" }],
      }),
      200,
    );
    expect(r.status).toBe("open");
    const d = await json<Detail>(await call("counter", "GET", `/counts/${c.id}`), 200);
    const line = d.lines.find((l) => l.variantId === a) as unknown as {
      note: string;
      recountRequested: boolean;
      round: number;
    };
    expect(line).toMatchObject({ note: "check the top shelf", recountRequested: true, round: 2 });
  });

  it("uncounted lines block approval; zeroUncounted books them as counted zero (an explicit choice)", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "3", 100);
    const c = await create(loc);
    await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 });
    await json<Header>(await call("counter", "POST", `/counts/${c.id}/close`, { version: 2 }), 200);
    expect((await call("reviewer", "POST", `/counts/${c.id}/approve`, { version: 3 })).status).toBe(
      409,
    );
    await json<Header>(
      await call("counter", "POST", `/counts/${c.id}/cancel`, { version: 3 }),
      200,
    );

    const loc2 = newLocation();
    const b = await untrackedWithStock(loc2, "3", 100);
    const c2 = await create(loc2);
    await call("counter", "POST", `/counts/${c2.id}/open`, { version: 1 });
    await json<Header>(
      await call("counter", "POST", `/counts/${c2.id}/close`, { version: 2, zeroUncounted: true }),
      200,
    );
    await json<Header>(
      await call("reviewer", "POST", `/counts/${c2.id}/approve`, { version: 3 }),
      200,
    );
    expect(await onHand(loc2, b, null)).toBe("0");
    expect(await onHand(loc, a, null)).toBe("3");
  });

  it("scans must match the variant's batch tracking, be known, and be unique per request", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "1");
    const b = await batchedWithStock(loc, "1");
    const c = await batchedWithStock(loc, "1");
    const count = await create(loc);
    await call("counter", "POST", `/counts/${count.id}/open`, { version: 1 });
    const post = (scans: unknown[]) =>
      call("counter", "POST", `/counts/${count.id}/scans`, { scans });
    expect((await post([scan(b.variantId, "1", null)])).status).toBe(422); // tracked: batch required
    expect((await post([scan(a, "1", b.batchId)])).status).toBe(422); // untracked: no batch
    expect((await post([scan(a, "1", uuidv7())])).status).toBe(422); // unknown batch
    expect((await post([scan(uuidv7(), "1")])).status).toBe(422); // unknown variant
    expect((await post([scan(b.variantId, "1", c.batchId)])).status).toBe(422); // another variant's batch
    const s = scan(a, "1");
    expect((await post([s, s])).status).toBe(422); // duplicate id in one request
  });

  it("a full count takes stock it did not expect (found) and posts it as a gain", async () => {
    const loc = newLocation();
    const other = await untrackedWithStock(loc, "2", 50);
    // Stock of this variant exists only at another location: its cost comes from that location (fallback).
    const elsewhere = await untrackedWithStock(newLocation(), "1", 50);
    const c = await create(loc);
    await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 });
    await json<{ accepted: number }>(
      await call("counter", "POST", `/counts/${c.id}/scans`, {
        scans: [scan(other, "2"), scan(elsewhere, "4")],
      }),
      200,
    );
    await json<Header>(await call("counter", "POST", `/counts/${c.id}/close`, { version: 2 }), 200);
    const v = await json<Variance>(await call("reviewer", "GET", `/counts/${c.id}/variance`), 200);
    expect(v.lines.find((l) => l.variantId === elsewhere)).toMatchObject({
      expectedQty: "0",
      varianceQty: "4",
      valueMinor: 200,
    });
    await json<Header>(
      await call("reviewer", "POST", `/counts/${c.id}/approve`, { version: 3 }),
      200,
    );
    expect(await onHand(loc, elsewhere, null)).toBe("4");
  });

  it("stock that arrives after the snapshot joins the count at close, and must be counted", async () => {
    const loc = newLocation();
    await untrackedWithStock(loc, "1");
    const c = await create(loc);
    const late = await untrackedWithStock(loc, "6", 80); // arrives after the snapshot, never scanned
    await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 });
    await json<Header>(await call("counter", "POST", `/counts/${c.id}/close`, { version: 2 }), 200);
    const v = await json<Variance>(await call("reviewer", "GET", `/counts/${c.id}/variance`), 200);
    const line = v.lines.find((l) => l.variantId === late);
    expect(line).toMatchObject({ expectedQty: "6", countedQty: null, varianceQty: null });
    expect(v.totals.unvaluedLines).toBe(0);
    expect((await call("reviewer", "POST", `/counts/${c.id}/approve`, { version: 3 })).status).toBe(
      409,
    );
  });

  it("a line in another currency is unvalued (null), never 0", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "3", 100); // USD cost
    const c = await create(loc, { currency: "EUR" });
    await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 });
    await json<{ accepted: number }>(
      await call("counter", "POST", `/counts/${c.id}/scans`, { scans: [scan(a, "1")] }),
      200,
    );
    await json<Header>(await call("counter", "POST", `/counts/${c.id}/close`, { version: 2 }), 200);
    const v = await json<Variance>(await call("reviewer", "GET", `/counts/${c.id}/variance`), 200);
    expect(v.lines[0]).toMatchObject({ varianceQty: "-2", valueMinor: null });
    expect(v.totals).toMatchObject({ shortValueMinor: 0, unvaluedLines: 1 });
    await json<Header>(
      await call("reviewer", "POST", `/counts/${c.id}/approve`, { version: 3 }),
      200,
    );
    expect(await onHand(loc, a, null)).toBe("1");
  });

  it("a blind count hides expected, variance and value from the counter after close, not from the reviewer", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "5", 100);
    const c = await create(loc, { blind: true });
    await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 });
    await call("counter", "POST", `/counts/${c.id}/scans`, { scans: [scan(a, "4")] });
    await json<Header>(await call("counter", "POST", `/counts/${c.id}/close`, { version: 2 }), 200);
    const hidden = await json<Variance>(
      await call("counter", "GET", `/counts/${c.id}/variance`),
      200,
    );
    expect(hidden.lines[0]).toMatchObject({
      expectedQty: null,
      varianceQty: null,
      valueMinor: null,
    });
    expect(hidden.totals).toMatchObject({ shortValueMinor: null, overValueMinor: null });
    const seen = await json<Variance>(
      await call("reviewer", "GET", `/counts/${c.id}/variance`),
      200,
    );
    expect(seen.lines[0]).toMatchObject({ expectedQty: "5", varianceQty: "-1", valueMinor: -100 });
  });

  it("a frozen count with no movement in its window approves", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "5", 100);
    const c = await create(loc, { mode: "frozen" });
    await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 });
    await call("counter", "POST", `/counts/${c.id}/scans`, { scans: [scan(a, "5")] });
    await json<Header>(await call("counter", "POST", `/counts/${c.id}/close`, { version: 2 }), 200);
    await json<Header>(
      await call("reviewer", "POST", `/counts/${c.id}/approve`, { version: 3 }),
      200,
    );
    expect(await onHand(loc, a, null)).toBe("5");
  });

  it("an approved count is terminal: no open, recount, close, cancel, or scan", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "2");
    const c = await create(loc);
    await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 });
    await call("counter", "POST", `/counts/${c.id}/scans`, { scans: [scan(a, "2")] });
    await json<Header>(await call("counter", "POST", `/counts/${c.id}/close`, { version: 2 }), 200);
    await json<Header>(
      await call("reviewer", "POST", `/counts/${c.id}/approve`, { version: 3 }),
      200,
    );
    expect((await call("counter", "POST", `/counts/${c.id}/cancel`, { version: 4 })).status).toBe(
      409,
    );
    expect((await call("counter", "POST", `/counts/${c.id}/close`, { version: 4 })).status).toBe(
      409,
    );
    expect((await call("counter", "POST", `/counts/${c.id}/open`, { version: 4 })).status).toBe(
      409,
    );
    expect(
      (
        await call("counter", "POST", `/counts/${c.id}/recounts`, {
          version: 4,
          lines: [{ variantId: a }],
        })
      ).status,
    ).toBe(409);
    expect(
      (await call("counter", "POST", `/counts/${c.id}/scans`, { scans: [scan(a, "1")] })).status,
    ).toBe(409);
  });

  it("creation refuses an unknown location, unknown or empty scopes, a full count with a scope, a reused id", async () => {
    const loc = newLocation();
    await untrackedWithStock(loc, "1");
    const base = { blind: false, mode: "live", currency: "USD" };
    expect(
      (await call("counter", "POST", "/counts", { ...base, locationId: uuidv7(), kind: "full" }))
        .status,
    ).toBe(422);
    expect(
      (
        await call("counter", "POST", "/counts", {
          ...base,
          locationId: loc,
          kind: "cycle",
          scope: { variantIds: [uuidv7()] },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("counter", "POST", "/counts", {
          ...base,
          locationId: loc,
          kind: "cycle",
          scope: { categoryIds: [uuidv7()] },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("counter", "POST", "/counts", {
          ...base,
          locationId: loc,
          kind: "full",
          scope: { categoryIds: [uuidv7()] },
        })
      ).status,
    ).toBe(422);
    const id = uuidv7();
    const first = await call("counter", "POST", "/counts", {
      ...base,
      id,
      locationId: loc,
      kind: "full",
    });
    expect(first.status).toBe(201);
    await json<Header>(await call("counter", "POST", `/counts/${id}/cancel`, { version: 1 }), 200);
    const loc2 = newLocation();
    await untrackedWithStock(loc2, "1");
    expect(
      (await call("counter", "POST", "/counts", { ...base, id, locationId: loc2, kind: "full" }))
        .status,
    ).toBe(409);
  });

  it("lists counts newest first with a keyset cursor, filters by status, and pages a count's lines", async () => {
    const loc1 = newLocation();
    await untrackedWithStock(loc1, "1");
    const c1 = await create(loc1);
    const loc2 = newLocation();
    await untrackedWithStock(loc2, "1");
    const c2 = await create(loc2);
    const page = await json<{ items: Header[]; nextCursor: string | null }>(
      await call("reader", "GET", "/counts?limit=1"),
      200,
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await json<{ items: Header[] }>(
      await call("reader", "GET", `/counts?limit=1&after=${String(page.nextCursor)}`),
      200,
    );
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    const drafts = await json<{ items: Header[] }>(
      await call("reader", "GET", "/counts?status=draft"),
      200,
    );
    expect(drafts.items.map((x) => x.id)).toEqual(expect.arrayContaining([c1.id, c2.id]));

    const loc3 = newLocation();
    for (const q of ["1", "2", "3"]) await untrackedWithStock(loc3, q);
    const c3 = await create(loc3);
    expect(c3.lineCount).toBe(3);
    const p1 = await json<Detail>(await call("reader", "GET", `/counts/${c3.id}?limit=2`), 200);
    expect(p1.lines).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await json<Detail>(
      await call(
        "reader",
        "GET",
        `/counts/${c3.id}?limit=2&after=${encodeURIComponent(String(p1.nextCursor))}`,
      ),
      200,
    );
    expect(p2.lines).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
  });

  it("close is refused on a draft, and an open response carries no lines", async () => {
    const loc = newLocation();
    await untrackedWithStock(loc, "1");
    const c = await create(loc);
    expect((await call("counter", "POST", `/counts/${c.id}/close`, { version: 1 })).status).toBe(
      409,
    );
    const opened = await json<Record<string, unknown>>(
      await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 }),
      200,
    );
    expect(opened).not.toHaveProperty("lines");
  });
});
