import { join } from "node:path";

import { generateKeyPair, sign } from "@wise-biz/crypto";
import { createPool, migrate } from "@wise-biz/db";
import { uuidv7 } from "@wise-biz/ids";
import { applyBatch, commandHash } from "@wise-biz/module-sync";
import { seedDemoTenant } from "@wise-biz/module-tenancy";
import { createMemoryStore } from "@wise-biz/storage";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSyncPorts } from "../src/sync-ports.ts";

import type { RawCommand } from "@wise-biz/module-sync";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

/** A terminal's signed commands through sync into the real sales, pricing, inventory and tenancy schemas. */
const modulesDir = join(import.meta.dirname, "..", "..", "..", "modules");
const T = uuidv7();
const OWNER = uuidv7();
const CASHIER = uuidv7();
const LIST = uuidv7();
const VARIANT = uuidv7();
const LOC = uuidv7();
const TODAY = new Date().toISOString().slice(0, 10);
const GENESIS = Buffer.alloc(32).toString("base64");

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Pool;
let branchId = "";
const keys = generateKeyPair();
const deviceId = uuidv7();
let seq = 0;
let last = GENESIS;
let saleNo = 0;

beforeAll(async () => {
  db = await testDatabase();
  await migrate(
    db.url("migrator"),
    ["infra", "audit", "tenancy", "devices", "pricing", "inventory", "sales", "sync"].map(
      (module) => ({ module, dir: join(modulesDir, module, "migrations") }),
    ),
  );
  pool = createPool(db.url("app"));
  admin = createPool(db.url("admin"));
  await seedDemoTenant(pool, {
    tenantId: T,
    ownerUserId: OWNER,
    members: [{ userId: CASHIER, roles: ["cashier"], scope: "all" }],
    now: new Date(),
    ids: { uuidv7 },
    requestId: "req-12345678",
  });
  branchId =
    (
      await admin.query<{ id: string }>(
        "select id from tenancy.branches where tenant_id = $1 order by id limit 1",
        [T],
      )
    ).rows[0]?.id ?? "";
  const region = uuidv7();
  await admin.query(
    `insert into pricing.tax_regions (id, tenant_id, code, name, inclusive, strategy) values ($1, $2, 'lk', 'LK', false, 'per-line')`,
    [region, T],
  );
  await admin.query(
    `insert into pricing.tax_rules (tenant_id, region_id, name, rate_bps, categories, ord) values ($1, $2, 'VAT', 1000, '{standard}', 0)`,
    [T, region],
  );
  await admin.query(
    `insert into pricing.price_lists (id, tenant_id, name, currency, tax_region_id) values ($1, $2, 'Retail', 'LKR', $3)`,
    [LIST, T, region],
  );
  await admin.query(
    "insert into pricing.prices (tenant_id, price_list_id, variant_id, price_minor) values ($1, $2, $3, 500)",
    [T, LIST, VARIANT],
  );
  await admin.query(
    `insert into pricing.variant_facts (tenant_id, variant_id, tax_category, source_time) values ($1, $2, 'standard', now())`,
    [T, VARIANT],
  );
  await admin.query(
    `insert into devices.devices (id, tenant_id, branch_id, name, platform, app_version, status, public_key, enrolled_by)
     values ($1, $2, $3, 'Till 1', 'linux', '1.0.0', 'active', $4, $5)`,
    [deviceId, T, branchId, Buffer.from(keys.publicKey), OWNER],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await db.drop();
});

function signed(type: string, body: Record<string, unknown>): RawCommand {
  const hash = commandHash(
    type,
    seq,
    body as RawCommand["body"],
    new Uint8Array(Buffer.from(last, "base64")),
  );
  const meta = {
    deviceSeq: seq,
    prevHash: last,
    hash: Buffer.from(hash).toString("base64"),
    signature: Buffer.from(sign(hash, keys.secretKey)).toString("base64"),
  };
  seq += 1;
  last = meta.hash;
  return { type, body: { ...body, meta } };
}
const deps = () => ({
  ...createSyncPorts(createMemoryStore()),
  pool,
  clock: { now: () => Date.now() },
  ids: { uuidv7 },
});
const ref = () => ({ tenantId: T, deviceId, branchId });
const now = () => new Date().toISOString();

describe("sync into sales", () => {
  it("a signed shift and sale are applied, priced against the server, and numbered", async () => {
    const shiftId = uuidv7();
    const open = signed("open_shift", {
      id: shiftId,
      operatorId: CASHIER,
      businessDate: TODAY,
      openedAt: now(),
      currency: "LKR",
      openingFloatMinor: 0,
    });
    const policyVersion = Number(
      (
        await admin.query<{ v: number }>(
          "select permissions_version v from tenancy.tenants where tenant_id = $1",
          [T],
        )
      ).rows[0]?.v,
    );
    const sale = (payableMinor: number) => {
      saleNo += 1;
      return signed("complete_sale", {
        id: uuidv7(),
        shiftId,
        operatorId: CASHIER,
        saleNo,
        currency: "LKR",
        businessDate: TODAY,
        completedAt: now(),
        priceListId: LIST,
        priceListVersion: 1,
        engineVersion: "1.0.0",
        policyVersion,
        promotionIds: [],
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
            taxMinor: 100,
            totalMinor: payableMinor,
          },
        ],
        tenders: [{ id: uuidv7(), kind: "cash", amountMinor: payableMinor }],
        subtotalMinor: 1000,
        discountMinor: 0,
        feeMinor: 0,
        taxMinor: 100,
        totalMinor: payableMinor,
        cashRoundingMinor: 0,
        payableMinor,
      });
    };
    const good = sale(1100);
    const bad = sale(900);
    const close = signed("close_shift", {
      id: shiftId,
      operatorId: CASHIER,
      closedAt: now(),
      countedCashMinor: 1100,
      blindCount: false,
    });
    const r = await applyBatch(deps(), ref(), "req-12345678", [open, good, bad, close]);
    expect(r.stopped).toBeNull();
    expect(r.acks.map((a) => a.status)).toEqual(["applied", "applied", "rejected", "applied"]);
    expect(r.acks[1]?.result).toMatchObject({ invoiceNo: "INV-000001", status: "completed" });
    expect(r.acks[2]?.error?.code).toBe("PRICE_MISMATCH");
    const z = await admin.query<{ over_short_minor: string; expected_cash_minor: string }>(
      "select over_short_minor, expected_cash_minor from sales.shifts where id = $1",
      [shiftId],
    );
    expect(z.rows[0]).toEqual({ over_short_minor: "0", expected_cash_minor: "1100" });
    // The rejected sale left no rows; the resent batch replays every answer.
    expect(
      Number(
        (
          await admin.query<{ n: string }>(
            "select count(*) n from sales.sales where shift_id = $1",
            [shiftId],
          )
        ).rows[0]?.n,
      ),
    ).toBe(1);
    const again = await applyBatch(deps(), ref(), "req-12345678", [open, good, bad, close]);
    expect(again.acks.map((a) => a.status)).toEqual([
      "replayed",
      "replayed",
      "rejected",
      "replayed",
    ]);
  });
});
