import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { CompleteSaleSchema, OpenShiftSchema } from "@wise-biz/contracts";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { completeSale, openShift } from "@wise-biz/module-sales";
import { seedDemoTenant } from "@wise-biz/module-tenancy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { salesPorts } from "../src/sales-ports.ts";

import type { TerminalContext } from "@wise-biz/module-sales";
import type { TestDatabase } from "@wise-biz/testing/containers";
import type pg from "pg";

/** The composition-root bridges sales uses, against the real tenancy, pricing and inventory schemas. */
const modulesDir = join(import.meta.dirname, "..", "..", "..", "modules");
const T = uuidv7();
const OWNER = uuidv7();
const CASHIER = uuidv7();
const LIST = uuidv7();
const VARIANT = uuidv7();
const LOC = uuidv7();
const TODAY = new Date().toISOString().slice(0, 10);

let db: TestDatabase;
let pool: pg.Pool;
let admin: pg.Pool;

beforeAll(async () => {
  db = await testDatabase();
  await migrate(
    db.url("migrator"),
    ["infra", "audit", "tenancy", "pricing", "inventory", "sales"].map((module) => ({
      module,
      dir: join(modulesDir, module, "migrations"),
    })),
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
  const region = uuidv7();
  await admin.query(
    `insert into pricing.tax_regions (id, tenant_id, code, name, inclusive, strategy) values ($1, $2, 'lk', 'LK', false,
       'per-line')`,
    [region, T],
  );
  await admin.query(
    `insert into pricing.tax_rules (tenant_id, region_id, name, rate_bps, categories, ord)
     values ($1, $2, 'VAT', 1000, '{standard}', 0)`,
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
    `insert into pricing.variant_facts (tenant_id, variant_id, tax_category, source_time)
     values ($1, $2, 'standard', now())`,
    [T, VARIANT],
  );
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await db.drop();
});

const tx = <R>(fn: (tx: Parameters<Parameters<typeof withTenantTx>[2]>[0]) => Promise<R>) =>
  withTenantTx(pool, { tenantId: T, requestId: "req-12345678" }, fn);
const meta = (deviceSeq: number) => ({
  deviceSeq,
  prevHash: randomBytes(32).toString("base64"),
  hash: randomBytes(32).toString("base64"),
  signature: randomBytes(64).toString("base64"),
});

describe("salesPorts.tenancy", () => {
  it("reports membership status and unconditional grants; the owner has every permission", async () => {
    const facts = await tx((x) => salesPorts.tenancy.operators(x, T, [OWNER, CASHIER, uuidv7()]));
    expect(facts.get(OWNER)).toEqual({ active: true, permissions: "all" });
    const cashier = facts.get(CASHIER);
    expect(cashier?.active).toBe(true);
    expect(cashier?.permissions).toBeInstanceOf(Set);
    const granted = cashier?.permissions as ReadonlySet<string>;
    expect(granted.has("sales:sell")).toBe(true);
    expect(granted.has("sales:void_late")).toBe(false);
    expect(facts.size).toBe(2);
    expect(await tx((x) => salesPorts.tenancy.operators(x, T, []))).toEqual(new Map());
    expect(await tx((x) => salesPorts.tenancy.policyVersion(x, T))).toBeGreaterThanOrEqual(1);
  });
});

describe("CompleteSale through the real pricing quote", () => {
  it("accepts the server price and rejects a device total beyond tolerance", async () => {
    const branch = await admin.query<{ id: string }>(
      "select id from tenancy.branches where tenant_id = $1 order by id limit 1",
      [T],
    );
    const t: TerminalContext = {
      tenantId: T,
      terminalId: uuidv7(),
      branchId: branch.rows[0]?.id ?? "",
      requestId: "req-12345678",
      now: new Date(),
      ids: { uuidv7 },
    };
    const shift = OpenShiftSchema.parse({
      id: uuidv7(),
      operatorId: CASHIER,
      businessDate: TODAY,
      openedAt: new Date().toISOString(),
      currency: "LKR",
      openingFloatMinor: 0,
      meta: meta(0),
    });
    await tx((x) => openShift(x, salesPorts, t, shift));
    const q = await tx((x) =>
      salesPorts.pricing.quote(
        x,
        T,
        { priceListId: LIST, lines: [{ id: "0", variantId: VARIANT, qty: "2" }] },
        new Date(),
      ),
    );
    expect(q.payableMinor).toBe(1100); // 2 x 500 + 10% VAT
    const policyVersion = await tx((x) => salesPorts.tenancy.policyVersion(x, T));
    const sale = (saleNo: number, payableMinor: number) =>
      CompleteSaleSchema.parse({
        id: uuidv7(),
        shiftId: shift.id,
        operatorId: CASHIER,
        saleNo,
        currency: "LKR",
        businessDate: TODAY,
        completedAt: new Date().toISOString(),
        priceListId: LIST,
        priceListVersion: 1,
        engineVersion: q.engine,
        policyVersion,
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
        meta: meta(saleNo),
      });
    const ok = await tx((x) => completeSale(x, salesPorts, t, sale(1, 1100)));
    expect(ok.body.flags).toEqual([]);
    const e = await tx((x) => completeSale(x, salesPorts, t, sale(2, 900))).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe("PRICE_MISMATCH");
  });
});
