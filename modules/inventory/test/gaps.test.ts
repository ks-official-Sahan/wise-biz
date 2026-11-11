import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, rlsSql, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createInventoryModule, recordMovements } from "../src/index.ts";

import type { GapEvidenceItem, GapEvidenceSource, MovementInput } from "../src/index.ts";
import type { AppEnv, CommandContext } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");

const T = uuidv7();
const OTHER = uuidv7();
const USER = uuidv7();
const locations = new Set<string>();

/** Sales-owned evidence, faked: the module must narrow whatever a source returns to the case's window and location. */
const fakeSources: { voids: GapEvidenceItem[] } = { voids: [] };
const fakeVoids: GapEvidenceSource = () => Promise.resolve(fakeSources.voids);

const inventoryModule = createInventoryModule({
  locationExists: (_tx, _tenant, id) => Promise.resolve(locations.has(id)),
  gapEvidence: { voids: fakeVoids },
});
const matrix = matrixFromRows(createCatalog(inventoryModule.permissions), [
  { role: "counter", permission: "counts:read" },
  { role: "counter", permission: "counts:write" },
  { role: "reviewer", permission: "counts:read" },
  { role: "reviewer", permission: "counts:approve" },
  { role: "gaps_manager", permission: "gaps:read" },
  { role: "gaps_manager", permission: "gaps:write" },
  { role: "gaps_manager", permission: "gaps:resolve" },
  { role: "gaps_writer", permission: "gaps:read" },
  { role: "gaps_writer", permission: "gaps:write" },
  { role: "gaps_reader", permission: "gaps:read" },
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
    c.set("requestId", "req-gaps-0001");
    c.set("auth", {
      kind: "user",
      userId: actor,
      sessionId: "01900000-0000-7000-8000-0000000000bb",
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
  tenant: { tenantId: t, userId: user, requestId: "req-gaps-0001" },
  userId: user,
  requestId: "req-gaps-0001",
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

/** An untracked variant received at a location (unit cost known in USD). */
async function untrackedWithStock(loc: string, qty: string, cost = 250): Promise<string> {
  const variantId = uuidv7();
  await admin.query(
    `insert into inventory.variant_facts (tenant_id, variant_id, tracks_batches, archived, source_time, category_ids)
     values ($1, $2, false, false, now(), '{}'::uuid[])`,
    [T, variantId],
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

/** One ledger document. */
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
  await withTenantTx(pool, { tenantId: T, userId: USER, requestId: "req-gaps-0001" }, (tx) =>
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

async function onHand(loc: string, variantId: string): Promise<number> {
  const r = await admin.query<{ qty: string }>(
    `select coalesce(sum(qty), 0)::text as qty from inventory.stock_balances
      where tenant_id = $1 and location_id = $2 and variant_id = $3`,
    [T, loc, variantId],
  );
  return Number(r.rows[0]?.qty ?? "0");
}

interface Header {
  id: string;
  status: string;
  version: number;
}
interface GapView {
  id: string;
  countId: string;
  locationId: string;
  variantId: string;
  varianceQty: string;
  valueMinor: number | null;
  status: string;
  assigneeId: string | null;
  resolutionCode: string | null;
  foundLocationId: string | null;
  foundQty: string | null;
  version: number;
  taskCount: number;
  openTaskCount: number;
}
interface TaskView {
  id: string;
  title: string;
  assigneeId: string | null;
  done: boolean;
}
interface Detail {
  case: GapView;
  tasks: TaskView[];
  evidence: {
    items: { source: string; kind: string; ref: string; occurredAt: string }[];
    truncated: boolean;
    unavailable: string[];
  };
}

const scan = (variantId: string, qty: string) => ({
  id: uuidv7(),
  variantId,
  batchId: null,
  qty,
  scannedAt: new Date().toISOString(),
});

/**
 * A full count of one location, approved. `during` runs after the snapshot and before the close (a window movement).
 * Returns the count id.
 */
async function approvedCount(
  loc: string,
  variantId: string,
  counted: string,
  opts: { currency?: string; during?: () => Promise<void> } = {},
): Promise<string> {
  const c = await json<Header>(
    await call("counter", "POST", "/counts", {
      locationId: loc,
      kind: "full",
      blind: false,
      mode: "live",
      currency: opts.currency ?? "USD",
    }),
    201,
  );
  await json<Header>(await call("counter", "POST", `/counts/${c.id}/open`, { version: 1 }), 200);
  if (opts.during !== undefined) await opts.during();
  await json<Header>(
    await call("counter", "POST", `/counts/${c.id}/scans`, { scans: [scan(variantId, counted)] }),
    200,
  );
  await json<Header>(await call("counter", "POST", `/counts/${c.id}/close`, { version: 2 }), 200);
  await json<Header>(
    await call("reviewer", "POST", `/counts/${c.id}/approve`, { version: 3 }),
    200,
  );
  return c.id;
}

async function generate(who: string, countId: string, body: unknown): Promise<Response> {
  return call(who, "POST", `/counts/${countId}/gaps`, body);
}

async function caseOf(countId: string, variantId: string): Promise<GapView> {
  const r = await admin.query<{ id: string }>(
    `select id from inventory.gap_cases where tenant_id = $1 and count_id = $2 and variant_id = $3`,
    [T, countId, variantId],
  );
  const id = r.rows[0]?.id ?? "";
  return json<Detail>(await call("gaps_reader", "GET", `/gap-cases/${id}`), 200).then(
    (d) => d.case,
  );
}

describe("permissions and surfaces", () => {
  it("unauthorized callers get 404 on every gap route", async () => {
    const id = uuidv7();
    const cases = [
      await call("none", "GET", "/gap-cases"),
      await call("none", "GET", `/gap-cases/${id}`),
      await call("none", "PATCH", `/gap-cases/${id}`, { version: 1, status: "investigating" }),
      await call("none", "POST", `/counts/${id}/gaps`, { minQty: "0" }),
      await call("none", "POST", `/gap-cases/${id}/resolve`, { version: 1, code: "theft" }),
    ];
    expect(cases.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
  });

  it("a reader cannot write, a writer cannot resolve (404), a manager can", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10");
    const countId = await approvedCount(loc, a, "8");
    expect((await generate("gaps_reader", countId, { minQty: "0" })).status).toBe(404);
    expect((await generate("gaps_writer", countId, { minQty: "0" })).status).toBe(201);
    const g = await caseOf(countId, a);
    const denied = await call("gaps_writer", "POST", `/gap-cases/${g.id}/resolve`, {
      version: g.version,
      code: "theft",
    });
    expect(denied.status).toBe(404);
    const ok = await call("gaps_manager", "POST", `/gap-cases/${g.id}/resolve`, {
      version: g.version,
      code: "theft",
    });
    expect(ok.status).toBe(200);
  });
});

describe("case creation from an approved count", () => {
  it("refuses a count that is not approved", async () => {
    const loc = newLocation();
    await untrackedWithStock(loc, "5");
    const c = await json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "full",
        blind: false,
        mode: "live",
        currency: "USD",
      }),
      201,
    );
    const r = await generate("gaps_manager", c.id, { minQty: "0" });
    expect(r.status).toBe(409);
  });

  it("one case per line over the threshold; a replay creates nothing (idempotent per count line)", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10");
    const b = await untrackedWithStock(loc, "4");
    // a is short by 2 (10 on the shelf, 8 counted); b is exact (no variance, no case).
    const countId = await json<Header>(
      await call("counter", "POST", "/counts", {
        locationId: loc,
        kind: "full",
        blind: false,
        mode: "live",
        currency: "USD",
      }),
      201,
    );
    await json<Header>(
      await call("counter", "POST", `/counts/${countId.id}/open`, { version: 1 }),
      200,
    );
    await json<Header>(
      await call("counter", "POST", `/counts/${countId.id}/scans`, {
        scans: [scan(a, "8"), scan(b, "4")],
      }),
      200,
    );
    await json<Header>(
      await call("counter", "POST", `/counts/${countId.id}/close`, { version: 2 }),
      200,
    );
    await json<Header>(
      await call("reviewer", "POST", `/counts/${countId.id}/approve`, { version: 3 }),
      200,
    );

    const first = await json<{ created: number; existing: number }>(
      await generate("gaps_manager", countId.id, { minQty: "0" }),
      201,
    );
    expect(first).toEqual({ countId: countId.id, created: 1, existing: 0 });
    const replay = await json<{ created: number; existing: number }>(
      await generate("gaps_manager", countId.id, { minQty: "0" }),
      201,
    );
    expect(replay).toEqual({ countId: countId.id, created: 0, existing: 1 });
    const rows = await admin.query<{ n: string }>(
      `select count(*)::text as n from inventory.gap_cases where tenant_id = $1 and count_id = $2`,
      [T, countId.id],
    );
    expect(rows.rows[0]?.n).toBe("1");
    const detected = await admin.query<{ n: string }>(
      `select count(*)::text as n from infra.outbox where tenant_id = $1 and type = 'inventory.gap.detected'
         and payload->'data'->>'countId' = $2`,
      [T, countId.id],
    );
    expect(detected.rows[0]?.n).toBe("1");
  });

  it("a threshold above the variance selects nothing; a line with no known cost is a case under a value threshold", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10");
    // Counted in EUR while the receipt is USD: the unit cost is unknown, so the value is null (never 0).
    const countId = await approvedCount(loc, a, "9", { currency: "EUR" });
    expect(
      (
        await json<{ created: number }>(
          await generate("gaps_manager", countId, { minQty: "5" }),
          201,
        )
      ).created,
    ).toBe(0);
    expect(
      (
        await json<{ created: number }>(
          await generate("gaps_manager", countId, { minValueMinor: 100 }),
          201,
        )
      ).created,
    ).toBe(1);
    const g = await caseOf(countId, a);
    expect(g.valueMinor).toBeNull();
    expect(g.varianceQty).toBe("-1");
  });

  it("generating needs gaps:write and a valid threshold", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "5");
    const countId = await approvedCount(loc, a, "5");
    expect((await generate("gaps_manager", countId, {})).status).toBe(422);
  });
});

describe("evidence: correlated events inside the count window", () => {
  it("shows the ledger and the wired source for the variant and location, nothing outside the window", async () => {
    const loc = newLocation();
    const other = newLocation();
    const a = await untrackedWithStock(loc, "10");
    // Before the count: outside the window (a write-off the count does not see as part of its window).
    await movement(
      loc,
      a,
      null,
      "-0.0001",
      "writeoff",
      { type: "adjustment", id: uuidv7() },
      null,
      new Date(Date.now() - 60_000),
    );
    const adjustId = uuidv7();
    const countId = await approvedCount(loc, a, "8", {
      during: async () => {
        // Inside the window: an adjustment at the location, and a void the fake sales source reports.
        await movement(loc, a, null, "-1", "adjust", { type: "adjustment", id: adjustId });
        const inside = new Date();
        fakeSources.voids = [
          {
            kind: "void",
            locationId: loc,
            variantId: a,
            occurredAt: inside,
            qty: "1",
            actorId: USER,
            ref: "sale/abc",
          },
          {
            kind: "void",
            locationId: other,
            variantId: a,
            occurredAt: inside,
            qty: "1",
            actorId: USER,
            ref: "sale/elsewhere",
          },
          {
            kind: "void",
            locationId: loc,
            variantId: a,
            occurredAt: new Date(Date.now() + 3_600_000),
            qty: "1",
            actorId: USER,
            ref: "sale/later",
          },
        ];
      },
    });
    expect((await generate("gaps_manager", countId, { minQty: "0" })).status).toBe(201);
    const g = await caseOf(countId, a);
    const detail = await json<Detail>(await call("gaps_reader", "GET", `/gap-cases/${g.id}`), 200);
    const refs = detail.evidence.items.map((i) => `${i.source}:${i.kind}:${i.ref}`);
    expect(refs).toContain(`inventory.ledger:adjust:adjustment/${adjustId}`);
    expect(refs).toContain("voids:void:sale/abc");
    expect(refs).not.toContain("voids:void:sale/elsewhere");
    expect(refs).not.toContain("voids:void:sale/later");
    expect(refs.some((x) => x.includes("writeoff"))).toBe(false);
    expect(detail.evidence.unavailable).toEqual([
      "returnsWithoutReceipt",
      "priceOverrides",
      "operatorsOnShift",
    ]);
    expect(detail.evidence.truncated).toBe(false);
    fakeSources.voids = [];
  });
});

describe("assignee and tasks", () => {
  it("moves a case to investigating, assigns it, and runs tasks; stale versions and no-ops are refused", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10");
    const countId = await approvedCount(loc, a, "8");
    await generate("gaps_manager", countId, { minQty: "0" });
    const g = await caseOf(countId, a);
    const assignee = uuidv7();

    const moved = await json<GapView>(
      await call("gaps_writer", "PATCH", `/gap-cases/${g.id}`, {
        version: g.version,
        status: "investigating",
        assigneeId: assignee,
      }),
      200,
    );
    expect(moved).toMatchObject({
      status: "investigating",
      assigneeId: assignee,
      version: g.version + 1,
    });
    expect(
      (
        await call("gaps_writer", "PATCH", `/gap-cases/${g.id}`, {
          version: g.version,
          status: "investigating",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("gaps_writer", "PATCH", `/gap-cases/${g.id}`, {
          version: moved.version,
          assigneeId: assignee,
        })
      ).status,
    ).toBe(409);

    const task = await json<{ task: TaskView; case: GapView }>(
      await call("gaps_writer", "POST", `/gap-cases/${g.id}/tasks`, {
        version: moved.version,
        title: "Check the back room",
        assigneeId: assignee,
      }),
      201,
    );
    expect(task.task).toMatchObject({
      title: "Check the back room",
      assigneeId: assignee,
      done: false,
    });
    expect(task.case.openTaskCount).toBe(1);

    const done = await json<{ task: TaskView; case: GapView }>(
      await call("gaps_writer", "PATCH", `/gap-cases/${g.id}/tasks/${task.task.id}`, {
        version: task.case.version,
        done: true,
      }),
      200,
    );
    expect(done.task.done).toBe(true);
    expect(done.case.openTaskCount).toBe(0);
    expect(
      (
        await call("gaps_writer", "PATCH", `/gap-cases/${g.id}/tasks/${task.task.id}`, {
          version: done.case.version,
          done: true,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("gaps_writer", "PATCH", `/gap-cases/${g.id}/tasks/${uuidv7()}`, {
          version: done.case.version,
          done: true,
        })
      ).status,
    ).toBe(404);
  });

  it("lists cases by status and assignee, newest first", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10");
    const countId = await approvedCount(loc, a, "8");
    await generate("gaps_manager", countId, { minQty: "0" });
    const g = await caseOf(countId, a);
    const assignee = uuidv7();
    await json<GapView>(
      await call("gaps_writer", "PATCH", `/gap-cases/${g.id}`, {
        version: g.version,
        assigneeId: assignee,
      }),
      200,
    );
    const mine = await json<{ items: GapView[] }>(
      await call("gaps_reader", "GET", `/gap-cases?assigneeId=${assignee}`),
      200,
    );
    expect(mine.items.map((x) => x.id)).toEqual([g.id]);
    const open = await json<{ items: GapView[] }>(
      await call("gaps_reader", "GET", "/gap-cases?status=open"),
      200,
    );
    expect(open.items.some((x) => x.id === g.id)).toBe(true);
  });
});

describe("resolution is audited and terminal", () => {
  it("a theft resolution is recorded with its audit row and moves no stock", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10");
    const countId = await approvedCount(loc, a, "8");
    await generate("gaps_manager", countId, { minQty: "0" });
    const g = await caseOf(countId, a);
    const before = await onHand(loc, a);
    const res = await json<GapView>(
      await call("gaps_manager", "POST", `/gap-cases/${g.id}/resolve`, {
        version: g.version,
        code: "theft",
        note: "Shelf empty on the walk-round.",
      }),
      200,
    );
    expect(res).toMatchObject({
      status: "resolved",
      resolutionCode: "theft",
      version: g.version + 1,
    });
    expect(await onHand(loc, a)).toBe(before);
    const audit = await admin.query<{ action: string; after: { resolutionCode: string } }>(
      `select action, after from audit.audit_log where tenant_id = $1 and entity = 'inventory.gap_case' and entity_id = $2
         and action = 'inventory.gap.resolved'`,
      [T, g.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.after.resolutionCode).toBe("theft");
    expect(
      (
        await call("gaps_manager", "POST", `/gap-cases/${g.id}/resolve`, {
          version: res.version,
          code: "damage",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("gaps_manager", "PATCH", `/gap-cases/${g.id}`, {
          version: res.version,
          status: "investigating",
        })
      ).status,
    ).toBe(409);
  });

  it("misplaced-found posts the found quantity at the location it was found, through the ledger", async () => {
    const loc = newLocation();
    const found = newLocation();
    const a = await untrackedWithStock(loc, "10");
    const countId = await approvedCount(loc, a, "8");
    await generate("gaps_manager", countId, { minQty: "0" });
    const g = await caseOf(countId, a);

    // Validation: a quantity over the shortage, a missing location, and the count's own location are refused.
    expect(
      (
        await call("gaps_manager", "POST", `/gap-cases/${g.id}/resolve`, {
          version: g.version,
          code: "misplaced_found",
          foundLocationId: found,
          foundQty: "3",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("gaps_manager", "POST", `/gap-cases/${g.id}/resolve`, {
          version: g.version,
          code: "misplaced_found",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("gaps_manager", "POST", `/gap-cases/${g.id}/resolve`, {
          version: g.version,
          code: "misplaced_found",
          foundLocationId: loc,
          foundQty: "1",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("gaps_manager", "POST", `/gap-cases/${g.id}/resolve`, {
          version: g.version,
          code: "misplaced_found",
          foundLocationId: uuidv7(),
          foundQty: "1",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call("gaps_manager", "POST", `/gap-cases/${g.id}/resolve`, {
          version: g.version,
          code: "theft",
          foundQty: "1",
        })
      ).status,
    ).toBe(422);

    const res = await json<GapView>(
      await call("gaps_manager", "POST", `/gap-cases/${g.id}/resolve`, {
        version: g.version,
        code: "misplaced_found",
        foundLocationId: found,
        foundQty: "2",
      }),
      200,
    );
    expect(res).toMatchObject({
      resolutionCode: "misplaced_found",
      foundLocationId: found,
      foundQty: "2",
    });
    expect(await onHand(found, a)).toBe(2);
    expect(await onHand(loc, a)).toBe(8);
    const ledger = await admin.query<{ n: string }>(
      `select count(*)::text as n from inventory.stock_movements
        where tenant_id = $1 and source_type = 'gap_case' and source_id = $2 and location_id = $3`,
      [T, g.id, found],
    );
    expect(ledger.rows[0]?.n).toBe("1");
    const outbox = await admin.query<{ n: string }>(
      `select count(*)::text as n from infra.outbox where tenant_id = $1 and type = 'inventory.movement.recorded'
         and payload->'data'->>'sourceType' = 'gap_case' and payload->'data'->>'sourceId' = $2`,
      [T, g.id],
    );
    expect(outbox.rows[0]?.n).toBe("1");
  });
});

describe("tenant isolation", () => {
  it("another tenant reads and writes nothing; the tables carry forced RLS", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10");
    const countId = await approvedCount(loc, a, "8");
    await generate("gaps_manager", countId, { minQty: "0" });
    const g = await caseOf(countId, a);
    const seen = await withTenantTx(pool, { tenantId: OTHER, userId: USER, requestId: "r" }, (tx) =>
      tx.query("select id from inventory.gap_cases where id = $1", [g.id]),
    );
    expect(seen.rows).toHaveLength(0);
    await expect(
      admin.query(
        `insert into inventory.gap_tasks (tenant_id, id, case_id, title, created_by, created_at, updated_at)
         values ($1, $2, $3, 'x', $4, now(), now())`,
        [OTHER, uuidv7(), g.id, USER],
      ),
    ).rejects.toThrow();
    for (const t of ["gap_cases", "gap_tasks"]) {
      expect(rlsSql("inventory", t)).toContain("FORCE ROW LEVEL SECURITY");
    }
  });

  it("one line has one case: a second case for the same count line is refused by the database", async () => {
    const loc = newLocation();
    const a = await untrackedWithStock(loc, "10");
    const countId = await approvedCount(loc, a, "8");
    await generate("gaps_manager", countId, { minQty: "0" });
    const g = await caseOf(countId, a);
    await expect(
      admin.query(
        `insert into inventory.gap_cases (tenant_id, id, count_id, location_id, variant_id, currency, variance_qty,
           window_from, window_to, status, version, opened_by, opened_at)
         select tenant_id, $2, count_id, location_id, variant_id, currency, variance_qty, window_from, window_to,
           'open', 1, opened_by, opened_at from inventory.gap_cases where tenant_id = $1 and id = $3`,
        [T, uuidv7(), g.id],
      ),
    ).rejects.toThrow();
  });
});

describe("query plans: each new query has an index (seqscan off)", () => {
  it("the case list, the task counts, and the evidence ledger read use their indexes", async () => {
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
    const list = await plan(
      "select id from inventory.gap_cases where tenant_id = $1 and status = 'open' order by id desc limit 26",
      [T],
    );
    expect(list).toMatch(/gap_cases_status_idx/);
    const byAssignee = await plan(
      "select id from inventory.gap_cases where tenant_id = $1 and assignee_id = $2 order by id desc limit 26",
      [T, USER],
    );
    expect(byAssignee).toMatch(/gap_cases_assignee_idx/);
    const tasks = await plan(
      "select case_id, count(*) from inventory.gap_tasks where tenant_id = $1 and case_id = any($2::uuid[]) group by case_id",
      [T, [uuidv7()]],
    );
    expect(tasks).toMatch(/gap_tasks_case_idx/);
    const ledger = await plan(
      `select occurred_at from inventory.stock_movements where tenant_id = $1 and variant_id = $2 and location_id = $3
         and occurred_at between $4 and $5 and reason = any($6::text[]) order by occurred_at desc, id desc limit 201`,
      [T, uuidv7(), uuidv7(), new Date(0), new Date(), ["adjust"]],
    );
    expect(ledger).toMatch(/Index/);
    expect(ledger).not.toMatch(/Seq Scan on stock_movements/);
  });
});
