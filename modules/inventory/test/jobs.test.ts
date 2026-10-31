import { join } from "node:path";

import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createLowStockConsumer,
  ensureInventoryPartitions,
  exclusive,
  recordMovements,
  runDriftCheck,
  runExpiringBatches,
} from "../src/index.ts";

import type { JobDeps, MovementInput } from "../src/index.ts";
import type { CommandContext } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const NOW = new Date("2026-10-29T10:00:00.000Z");
const LOC = uuidv7();

let pool: pg.Pool;
let worker: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
let deps: JobDeps;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "inventory", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
  worker = createPool(db.url("worker"));
  admin = createPool(db.url("admin"));
  deps = { pool: worker, ids: { uuidv7 }, now: () => NOW };
  drop = async () => {
    await pool.end();
    await worker.end();
    await admin.end();
    await db.drop();
  };
});
afterAll(async () => {
  await drop();
});

const ctxFor = (tenantId: string): CommandContext => ({
  tenant: { tenantId, requestId: "req-12345678" },
  userId: uuidv7(),
  requestId: "req-12345678",
  now: NOW,
  ids: { uuidv7 },
});
async function move(tenantId: string, movements: MovementInput[]) {
  return withTenantTx(pool, { tenantId, requestId: "t" }, (tx) =>
    recordMovements(
      tx,
      ctxFor(tenantId),
      { type: "adjustment", id: uuidv7(), occurredAt: NOW },
      movements,
    ),
  );
}
const outbox = async (tenantId: string, type: string) => {
  const r = await admin.query<{ key: string; payload: { data: Record<string, unknown> } }>(
    "select key, payload from infra.outbox where tenant_id = $1 and type = $2 order by id",
    [tenantId, type],
  );
  return r.rows;
};

describe("low stock", () => {
  it("fires once below min, stays quiet while low, re-arms when stock recovers", async () => {
    const t = uuidv7();
    const v = uuidv7();
    await admin.query(
      "insert into inventory.stock_thresholds (tenant_id, location_id, variant_id, min_qty) values ($1, $2, $3, 5)",
      [t, LOC, v],
    );
    const consumer = createLowStockConsumer(deps);
    const step = async (qty: string) => {
      const r = await move(t, [
        { locationId: LOC, variantId: v, qty, reason: "adjust", sourceLine: 0 },
      ]);
      const ev = r.events.find((e) => e.type === "inventory.movement.recorded");
      await withTenantTx(worker, { tenantId: t, requestId: "c" }, (client) =>
        consumer.handle(
          { payload: JSON.parse(JSON.stringify(ev?.payload)) as unknown },
          { client: client as never },
        ),
      );
      return (await outbox(t, "inventory.balance.low")).length;
    };
    expect(await step("10")).toBe(0);
    expect(await step("-6")).toBe(1);
    expect(await step("-1")).toBe(1);
    expect(await step("10")).toBe(1);
    expect(await step("-12")).toBe(2);
    const [first] = await outbox(t, "inventory.balance.low");
    expect(first?.key).toBe(`${t}:${v}`);
    expect(first?.payload.data).toMatchObject({ qty: "4", minQty: "5", maxQty: null });
    // A movement at a location without a threshold does nothing.
    const other = await move(t, [
      { locationId: uuidv7(), variantId: v, qty: "-1", reason: "adjust", sourceLine: 0 },
    ]);
    await withTenantTx(worker, { tenantId: t, requestId: "c" }, (client) =>
      consumer.handle(
        { payload: JSON.parse(JSON.stringify(other.events[0]?.payload)) as unknown },
        { client: client as never },
      ),
    );
    expect((await outbox(t, "inventory.balance.low")).length).toBe(2);
  });
});

describe("expiring batches", () => {
  it("announces batches with stock entering the horizon, once", async () => {
    const t = uuidv7();
    const v = uuidv7();
    const batch = async (expiresOn: string | null) => {
      const id = uuidv7();
      await admin.query(
        `insert into inventory.batches (tenant_id, id, variant_id, lot_code, expires_on, currency, unit_cost_minor, received_at)
         values ($1, $2, $3, 'L', $4, 'LKR', 1, now())`,
        [t, id, v, expiresOn],
      );
      return id;
    };
    const [soon, today, far, none] = [
      await batch("2026-11-03"),
      await batch("2026-10-29"),
      await batch("2027-01-01"),
      await batch(null),
    ];
    // Expires soon but holds no stock: never announced.
    await batch("2026-11-01");
    await move(
      t,
      [soon, today, far, none].map((b, i) => ({
        locationId: LOC,
        variantId: v,
        batchId: b,
        qty: "3",
        reason: "receive" as const,
        sourceLine: i,
      })),
    );
    expect(await runExpiringBatches(deps, 7)).toBe(2);
    expect(await runExpiringBatches(deps, 7)).toBe(0);
    const evs = await outbox(t, "inventory.batch.expiring");
    expect(evs.map((e) => e.payload.data.batchId).sort()).toEqual([soon, today].sort());
    expect(evs[0]?.payload.data.stock).toEqual([{ locationId: LOC, qty: "3" }]);
    // A wider horizon picks up the far batch.
    expect(await runExpiringBatches(deps, 90)).toBe(1);
  });
});

describe("drift check", () => {
  it("finds an injected mismatch and records the result per tenant", async () => {
    const t = uuidv7();
    const [v1, v2] = [uuidv7(), uuidv7()];
    await move(t, [
      { locationId: LOC, variantId: v1, qty: "5", reason: "receive", sourceLine: 0 },
      { locationId: LOC, variantId: v2, qty: "2", reason: "receive", sourceLine: 1 },
    ]);
    const before = await runDriftCheck(deps);
    await admin.query(
      "update inventory.stock_balances set qty = qty + 1 where tenant_id = $1 and variant_id = $2",
      [t, v2],
    );
    expect(await runDriftCheck(deps)).toBe(before + 1);
    const evs = await outbox(t, "inventory.drift.detected");
    expect(evs.map((e) => e.payload.data)).toEqual([
      { locationId: LOC, variantId: v2, batchId: null, balanceQty: "3", ledgerQty: "2" },
    ]);
    const r = await admin.query<{ mismatches: number }>(
      "select mismatches from inventory.drift_checks where tenant_id = $1",
      [t],
    );
    expect(r.rows[0]?.mismatches).toBe(1);
  });
});

describe("partitions and locking", () => {
  it("ensure_partitions is idempotent and extends the horizon", async () => {
    expect(await ensureInventoryPartitions(worker)).toBe(0);
    expect(await ensureInventoryPartitions(worker, 12, 5)).toBeGreaterThan(0);
    await expect(ensureInventoryPartitions(worker, 99, 1)).rejects.toThrow(/months_back/);
  });

  it("exclusive runs a job once across concurrent callers", async () => {
    let inside = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = exclusive(worker, "inv-test", async () => {
      inside++;
      await gate;
      return "ran";
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = await exclusive(worker, "inv-test", () => Promise.resolve("ran too"));
    release();
    expect([await first, second, inside]).toEqual(["ran", undefined, 1]);
    expect(await exclusive(worker, "inv-test", () => Promise.resolve("again"))).toBe("again");
  });
});
