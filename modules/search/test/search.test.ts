import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { VariantUpsertedV1 } from "@wise-biz/module-catalog";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, definePermissions, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSearchModule, createSearchProjectionConsumer } from "../src/index.ts";
import { norm, prefixQuery } from "../src/query.ts";

import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const OTHER = uuidv7();
let role = "owner";
let tenantId = T;

let app: OpenAPIHono<AppEnv>;
let pool: pg.Pool;
let worker: pg.Pool;
let drop: () => Promise<void>;
const consumer = createSearchProjectionConsumer();

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "search", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
  worker = createPool(db.url("worker"));
  drop = async () => {
    await pool.end();
    await worker.end();
    await db.drop();
  };
  const matrix = matrixFromRows(createCatalog(definePermissions("catalog", ["read"])), [
    { role: "owner", permission: "catalog:read" },
  ]);
  app = new OpenAPIHono<AppEnv>({
    defaultHook: (r) => {
      if (!r.success) throw new DomainError("VALIDATION_FAILED", "invalid request");
    },
  });
  app.use("*", async (c, next) => {
    c.set("requestId", "req-12345678");
    c.set("auth", {
      kind: "user",
      userId: uuidv7(),
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
  createSearchModule().routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });
});
afterAll(async () => {
  await drop();
});

/** Builds the event exactly as catalog emits it (contract test) and runs the consumer the way the pg bus does. */
async function deliver(
  tenant: string,
  data: Partial<{
    variantId: string;
    productId: string;
    productName: string;
    name: string;
    sku: string;
    barcodes: string[];
    archived: boolean;
  }>,
  time = new Date(),
) {
  const payload = VariantUpsertedV1.parse({
    id: uuidv7(),
    type: VariantUpsertedV1.type,
    version: VariantUpsertedV1.version,
    source: "api/catalog",
    tenantId: tenant,
    subject: "variant/x",
    time: time.toISOString(),
    correlationId: "c",
    actor: { type: "user", id: uuidv7() },
    data: {
      productId: uuidv7(),
      variantId: uuidv7(),
      productName: "Product",
      name: "Default",
      sku: `SKU-${uuidv7().slice(-8)}`,
      barcodes: [],
      unitId: null,
      taxCategory: "standard",
      tracksBatches: false,
      categoryPath: ["Drinks"],
      tags: ["cold"],
      archived: false,
      ...data,
    },
  });
  const client = await worker.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenant]);
    await consumer.handle({ payload }, { client });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  return payload.data;
}

const search = async (q: string) => {
  const res = await app.request(`/v1/search/variants?q=${encodeURIComponent(q)}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { hits: { variantId: string; title: string }[] }).hits;
};

describe("normalisation", () => {
  it("matches search.norm() and builds a safe prefix tsquery", () => {
    expect(norm("Coca-Cola 1.5L")).toBe("cocacola 15l");
    expect(prefixQuery(norm("cocacola  1.5"))).toBe("cocacola:* & 15:*");
    expect(prefixQuery(norm("a & b | !c:*"))).toBe("a:* & b:* & c:*");
    // Letters and combining marks survive (Sinhala: "කිරි" = milk).
    expect(norm("කිරි 1L")).toBe("කිරි 1l");
  });
});

describe("projection + hybrid query", () => {
  it('typo "cocacola 1.5" finds "Coca-Cola 1.5L" first', async () => {
    const coke = await deliver(T, { productName: "Coca-Cola", name: "1.5L" });
    await deliver(T, { productName: "Coca-Cola", name: "330ml can" });
    await deliver(T, { productName: "Pepsi", name: "1.5L" });
    const hits = await search("cocacola 1.5");
    expect(hits[0]).toMatchObject({ variantId: coke.variantId, title: "Coca-Cola 1.5L" });
    expect((await search("coca col"))[0]?.title).toMatch(/^Coca-Cola/);
    expect((await search(coke.sku))[0]?.variantId).toBe(coke.variantId);
  });

  it("archived variants drop out; an older event never overwrites a newer document", async () => {
    const v = await deliver(T, { productName: "Sprite", name: "500ml" });
    expect((await search("sprite")).map((h) => h.variantId)).toContain(v.variantId);
    await deliver(T, { ...v, archived: true });
    expect((await search("sprite")).map((h) => h.variantId)).not.toContain(v.variantId);
    await deliver(T, { ...v, archived: false }, new Date(Date.now() - 60_000));
    expect((await search("sprite")).map((h) => h.variantId)).not.toContain(v.variantId);
  });

  it("is tenant-scoped, and 404 without catalog:read", async () => {
    await deliver(OTHER, { productName: "Fanta Orange", name: "1L" });
    expect(await search("fanta")).toEqual([]);
    tenantId = OTHER;
    try {
      expect(await search("fanta")).toHaveLength(1);
      role = "cashier";
      expect((await app.request("/v1/search/variants?q=fanta")).status).toBe(404);
    } finally {
      role = "owner";
      tenantId = T;
    }
  });

  it("an empty query after normalisation returns nothing", async () => {
    expect(await search("!!!")).toEqual([]);
  });
});

describe("direct", () => {
  it("withTenantTx reads as wb_app (no write grant)", async () => {
    await expect(
      withTenantTx(pool, { tenantId: T, requestId: "x" }, (tx) =>
        tx.query("delete from search.search_documents where tenant_id = $1", [T]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
