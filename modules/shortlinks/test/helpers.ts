import { join } from "node:path";

import { createPool, migrate } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { testDatabase } from "@wise-biz/testing/containers";

import { createReceiptLinkConsumer } from "../src/index.ts";

import type pg from "pg";

export const migrationsDir = join(import.meta.dirname, "..", "migrations");
const infraDir = join(import.meta.dirname, "..", "..", "infra", "migrations");

export const clock = { now: () => Date.UTC(2026, 0, 1) };
export const ids = { uuidv7 };

export const consumer = createReceiptLinkConsumer();

export interface Fixture {
  /** wb_app: the API. */
  pool: pg.Pool;
  /** wb_worker: the consumers. */
  worker: pg.Pool;
  /** wb_migrator: owner, used to inspect rows across tenants. */
  migrator: pg.Pool;
  drop: () => Promise<void>;
}

export async function setup(): Promise<Fixture> {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: infraDir },
    { module: "shortlinks", dir: migrationsDir },
  ]);
  const pool = createPool(db.url("app"));
  const worker = createPool(db.url("worker"));
  const migrator = createPool(db.url("migrator"));
  return {
    pool,
    worker,
    migrator,
    drop: async () => {
      await pool.end();
      await worker.end();
      await migrator.end();
      await db.drop();
    },
  };
}

/** A sales.sale.completed@v1 envelope as the outbox delivers it. Carries the fields a receipt must NOT expose. */
export function saleEvent(
  tenantId: string,
  saleId: string,
  over: {
    payableMinor?: number;
    sku?: string;
    tenders?: { kind: string; amountMinor: number }[];
  } = {},
): Record<string, unknown> {
  const sku = over.sku ?? "SKU-1";
  const payable = over.payableMinor ?? 1250;
  return {
    id: uuidv7(),
    type: "sales.sale.completed",
    version: 1,
    source: "api/sales",
    tenantId,
    branchId: uuidv7(),
    subject: `sale/${saleId}`,
    time: "2026-11-01T10:00:00.000Z",
    actor: { type: "device", id: uuidv7() },
    data: {
      saleId,
      branchId: uuidv7(),
      terminalId: uuidv7(),
      shiftId: uuidv7(),
      operatorId: uuidv7(),
      customerId: uuidv7(),
      saleNo: 123,
      invoiceNo: "INV-000123",
      currency: "USD",
      businessDate: "2026-11-01",
      completedAt: "2026-11-01T10:00:00.000Z",
      subtotalMinor: 1300,
      discountMinor: 50,
      feeMinor: 0,
      taxMinor: 0,
      totalMinor: payable,
      cashRoundingMinor: 0,
      payableMinor: payable,
      promotionIds: [],
      coupons: [],
      flags: [],
      lines: [
        {
          line: 1,
          variantId: uuidv7(),
          sku,
          locationId: uuidv7(),
          batchId: null,
          qty: "2",
          unitPriceMinor: 650,
          discountMinor: 50,
          taxMinor: 0,
          totalMinor: 1250,
          unitCostMinor: null,
        },
      ],
      tenders: over.tenders ?? [{ kind: "cash", amountMinor: 1250 }],
    },
  };
}

/** Runs fn in a worker transaction with app.tenant_id set the way the pg bus does (events/src/pg.ts). */
export async function inTenantTx<T>(
  worker: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await worker.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
