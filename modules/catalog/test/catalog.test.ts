import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate, withTenantTx } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listProducts } from "../src/application/queries.ts";
import { gs1CheckDigitOk, normaliseBarcode, upceToUpca } from "../src/domain/barcode.ts";
import { createCatalogModule } from "../src/index.ts";

import type { TxHandle } from "@wise-biz/db";
import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const OTHER = uuidv7();
const USER = uuidv7();
let tenantId = T;
let role = "owner";
let device: "active" | "suspended" | null = null;

const catalogModule = createCatalogModule();
const matrix = matrixFromRows(createCatalog(catalogModule.permissions), [
  { role: "owner", permission: "catalog:read" },
  { role: "owner", permission: "catalog:write" },
  { role: "cashier", permission: "catalog:read" },
]);

let pool: pg.Pool;
/** The outbox is write-only for wb_app; tests read it as admin. */
let admin: pg.Pool;
let drop: () => Promise<void>;
let app: OpenAPIHono<AppEnv>;

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "catalog", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
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
    c.set(
      "auth",
      device === null
        ? {
            kind: "user",
            userId: USER,
            sessionId: "01900000-0000-7000-8000-0000000000aa",
            tenantId,
            roles: [role],
            branchScope: "all",
            permissionsVersion: 1,
          }
        : { kind: "anonymous" },
    );
    c.set(
      "device",
      device === null
        ? undefined
        : { deviceId: uuidv7(), tenantId, branchId: uuidv7(), status: device },
    );
    c.set("logger", { info: () => undefined } as never);
    await next();
  });
  app.use("*", policyMiddleware(matrix));
  app.onError((err, c) => {
    const p = toProblem(err, "r");
    return c.json(p, p.status as 404);
  });
  catalogModule.routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });
});
afterAll(async () => {
  await drop();
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", "idempotency-key": `k-${uuidv7()}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async <R>(res: Response) => (await res.json()) as R;

interface Product {
  id: string;
  version: number;
  archived: boolean;
  tagIds: string[];
  variants: {
    id: string;
    version: number;
    sku: string;
    barcodes?: { code: string; format: string }[];
  }[];
}

/** EAN-13 with a correct check digit from a 12-digit body. */
function ean13(body12: string): string {
  for (let d = 0; d <= 9; d++)
    if (gs1CheckDigitOk(`${body12}${String(d)}`)) return `${body12}${String(d)}`;
  throw new Error("unreachable");
}
let seq = 100_000;
const nextEan = () => ean13(`200${String(seq++).padStart(9, "0")}`);
const nextSku = () => `SKU-${String(seq++)}`;

async function product(over: Record<string, unknown> = {}, barcodes = [nextEan()]) {
  const res = await send("POST", "/v1/catalog/products", {
    name: "Coca-Cola 1.5L",
    variants: [{ sku: nextSku(), name: "Bottle", barcodes: barcodes.map((code) => ({ code })) }],
    ...over,
  });
  expect(res.status).toBe(201);
  return json<Product>(res);
}

const outbox = async (type: string) => {
  const r = await admin.query<{ payload: { data: Record<string, unknown> } }>(
    "select payload from infra.outbox where tenant_id = $1 and type = $2 order by id",
    [T, type],
  );
  return r.rows.map((x) => x.payload.data);
};

describe("barcode domain", () => {
  it("infers formats and checks GS1 check digits", () => {
    expect(normaliseBarcode({ code: "4006381333931" }, 0)).toEqual({
      code: "4006381333931",
      format: "ean13",
    });
    expect(normaliseBarcode({ code: "96385074" }, 0).format).toBe("ean8");
    expect(normaliseBarcode({ code: "ABC-123" }, 0).format).toBe("code128");
    expect(() => normaliseBarcode({ code: "4006381333932" }, 0)).toThrow(DomainError);
    expect(() => normaliseBarcode({ code: "12345", format: "ean13" }, 0)).toThrow(DomainError);
    // UPC-E is checked against its UPC-A expansion (04252614 -> 042100005264).
    expect(upceToUpca("04252614")).toBe("042100005264");
    expect(normaliseBarcode({ code: "04252614", format: "upce" }, 0).format).toBe("upce");
    expect(() => normaliseBarcode({ code: "04252615", format: "upce" }, 0)).toThrow(DomainError);
  });
});

describe("products", () => {
  it("creates a product with variants and barcodes; audit + self-sufficient events in the same tx", async () => {
    const tag = await json<{ id: string }>(
      await send("POST", "/v1/catalog/tags", { name: `Drinks ${uuidv7()}` }),
    );
    const code = nextEan();
    const p = await product({
      tagIds: [tag.id],
      variants: [
        { sku: nextSku(), name: "1.5L", barcodes: [{ code }] },
        { sku: nextSku(), name: "Pack of 6", attributes: { pack: 6 } },
      ],
    });
    expect(p.variants).toHaveLength(2);
    expect(p.variants[0]?.barcodes).toEqual([{ code, format: "ean13" }]);
    expect(p.tagIds).toEqual([tag.id]);
    const upserts = await outbox("catalog.variant.upserted");
    const mine = upserts.filter((d) => d.productId === p.id);
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({
      productName: "Coca-Cola 1.5L",
      barcodes: [code],
      archived: false,
    });
    expect(mine[0]?.tags).toHaveLength(1);
    expect((await outbox("catalog.product.upserted")).some((d) => d.productId === p.id)).toBe(true);
    const audit = await withTenantTx(pool, { tenantId: T, requestId: "t" }, (tx) =>
      tx.query("select 1 from audit.audit_log where tenant_id = $1 and entity_id = $2", [T, p.id]),
    );
    expect(audit.rowCount).toBe(1);
  });

  it("a duplicate barcode is rejected in the same business and allowed in another", async () => {
    const code = nextEan();
    await product({}, [code]);
    const dup = await send("POST", "/v1/catalog/products", {
      name: "Copy",
      variants: [{ sku: nextSku(), name: "x", barcodes: [{ code }] }],
    });
    expect(dup.status).toBe(409);
    expect((await json<{ detail: string }>(dup)).detail).toMatch(/barcode/i);
    tenantId = OTHER;
    try {
      await product({}, [code]);
    } finally {
      tenantId = T;
    }
  });

  it("rejects a wrong check digit (422) and an unknown category (422)", async () => {
    const bad = await send("POST", "/v1/catalog/products", {
      name: "x",
      variants: [{ sku: nextSku(), name: "x", barcodes: [{ code: "4006381333932" }] }],
    });
    expect(bad.status).toBe(422);
    const cat = await send("POST", "/v1/catalog/products", {
      name: "x",
      categoryId: uuidv7(),
      variants: [{ sku: nextSku(), name: "x" }],
    });
    expect(cat.status).toBe(422);
  });

  it("optimistic lock: a stale version gets 409; archive emits variant.archived", async () => {
    const p = await product();
    const ok = await send("PATCH", `/v1/catalog/products/${p.id}`, {
      version: p.version,
      name: "Renamed",
    });
    expect(ok.status).toBe(200);
    const stale = await send("PATCH", `/v1/catalog/products/${p.id}`, {
      version: p.version,
      name: "Again",
    });
    expect(stale.status).toBe(409);
    const arch = await send("PATCH", `/v1/catalog/products/${p.id}`, {
      version: p.version + 1,
      archived: true,
    });
    expect((await json<Product>(arch)).archived).toBe(true);
    const archived = await outbox("catalog.variant.archived");
    expect(archived.some((d) => d.productId === p.id)).toBe(true);
  });

  it("404 for a caller without catalog:write, before validation", async () => {
    role = "cashier";
    try {
      expect((await send("POST", "/v1/catalog/products", { nonsense: true })).status).toBe(404);
      expect((await send("GET", "/v1/catalog/products")).status).toBe(200);
    } finally {
      role = "owner";
    }
  });
});

describe("barcode lookup", () => {
  it("finds sellable variants for users and active terminals; archived and suspended are refused", async () => {
    const code = nextEan();
    const p = await product({}, [code]);
    const hit = await send("GET", `/v1/catalog/barcodes/${code}`);
    expect(hit.status).toBe(200);
    expect(await json(hit)).toMatchObject({ code, product: { id: p.id } });

    device = "active";
    try {
      expect((await send("GET", `/v1/catalog/barcodes/${code}`)).status).toBe(200);
      // Authorization runs before validation: an over-long code from a suspended terminal is 401, not 422.
      device = "suspended";
      expect((await send("GET", `/v1/catalog/barcodes/${"9".repeat(80)}`)).status).toBe(401);
      expect((await send("GET", `/v1/catalog/barcodes/${code}`)).status).toBe(401);
    } finally {
      device = null;
    }

    const v = p.variants[0];
    if (v === undefined) throw new Error("no variant");
    const arch = await send("PATCH", `/v1/catalog/variants/${v.id}`, {
      version: v.version,
      archived: true,
    });
    expect(arch.status).toBe(200);
    expect((await send("GET", `/v1/catalog/barcodes/${code}`)).status).toBe(404);
  });

  it("an archived variant keeps its code reserved until it is removed from that variant", async () => {
    const code = nextEan();
    const p = await product({}, [code]);
    const v = p.variants[0];
    if (v === undefined) throw new Error("no variant");
    await send("PATCH", `/v1/catalog/variants/${v.id}`, { version: v.version, archived: true });
    const taken = await send("POST", "/v1/catalog/products", {
      name: "New",
      variants: [{ sku: nextSku(), name: "x", barcodes: [{ code }] }],
    });
    expect(taken.status).toBe(409);
    const cleared = await send("PUT", `/v1/catalog/variants/${v.id}/barcodes`, { barcodes: [] });
    expect(cleared.status).toBe(200);
    const changed = await outbox("catalog.barcode.changed");
    expect(
      changed.some((d) => d.variantId === v.id && (d.removed as string[]).includes(code)),
    ).toBe(true);
    await product({}, [code]);
  });
});

describe("list", () => {
  it("50 products with variants, barcodes and media is 4 queries; keyset pages cover every row once", async () => {
    tenantId = uuidv7();
    const scope = tenantId;
    try {
      for (let i = 0; i < 60; i++) await product({ name: `Item ${String(i)}` });
      const p0 = await json<{ products: Product[] }>(
        await send("GET", "/v1/catalog/products?limit=1"),
      );
      const pid = p0.products[0]?.id ?? "";
      await withTenantTx(pool, { tenantId: scope, requestId: "t" }, (tx) =>
        tx.query(
          "insert into catalog.product_media (tenant_id, product_id, asset_key) values ($1, $2, 'tenants/x/p.webp')",
          [scope, pid],
        ),
      );
      let count = 0;
      const page = await withTenantTx(pool, { tenantId: scope, requestId: "t" }, (tx) => {
        const counted: TxHandle = {
          db: tx.db,
          query: (text, values) => {
            count++;
            return tx.query(text, values);
          },
        };
        return listProducts(counted, scope, { limit: 50, include: "variants,barcodes,media" });
      });
      expect(count).toBe(4);
      expect(page.products).toHaveLength(50);
      expect(page.products[0]?.media).toHaveLength(1);
      expect(page.products[1]?.variants?.[0]?.barcodes).toHaveLength(1);

      const seen = new Set<string>();
      let next: string | null = null;
      do {
        const q: string = next === null ? "" : `&after=${next}`;
        const r = await json<{ products: Product[]; next: string | null }>(
          await send("GET", `/v1/catalog/products?limit=25${q}`),
        );
        for (const x of r.products) seen.add(x.id);
        next = r.next;
      } while (next !== null);
      expect(seen.size).toBe(60);
    } finally {
      tenantId = T;
    }
  });

  it("filters by category subtree (after a move), tag, archived and updatedSince", async () => {
    tenantId = uuidv7();
    try {
      const mk = async (name: string, parentId?: string) =>
        json<{ id: string; path: string[] }>(
          await send("POST", "/v1/catalog/categories", { name, ...(parentId ? { parentId } : {}) }),
        );
      const food = await mk("Food");
      const drinks = await mk("Drinks");
      const soda = await mk("Soda", food.id);
      const p = await product({ categoryId: soda.id });
      const moved = await send("PATCH", `/v1/catalog/categories/${soda.id}`, {
        parentId: drinks.id,
      });
      expect(await json(moved)).toMatchObject({ parentId: drinks.id, path: [drinks.id, soda.id] });
      const loop = await send("PATCH", `/v1/catalog/categories/${drinks.id}`, {
        parentId: soda.id,
      });
      expect(loop.status).toBe(422);

      const ids = async (q: string) =>
        (
          await json<{ products: Product[] }>(await send("GET", `/v1/catalog/products?${q}`))
        ).products.map((x) => x.id);
      expect(await ids(`categoryId=${drinks.id}`)).toEqual([p.id]);
      expect(await ids(`categoryId=${food.id}`)).toEqual([]);
      // The move re-emitted the product's variants with the new category path (search stays fresh).
      const scope = tenantId;
      const r = await admin.query<{
        payload: { data: { productId: string; categoryPath: string[] } };
      }>(
        "select payload from infra.outbox where tenant_id = $1 and type = 'catalog.variant.upserted' order by id desc limit 1",
        [scope],
      );
      expect(r.rows[0]?.payload.data).toMatchObject({
        productId: p.id,
        categoryPath: ["Drinks", "Soda"],
      });

      const tag = await json<{ id: string }>(
        await send("POST", "/v1/catalog/tags", { name: "Promo" }),
      );
      const other = await product({ tagIds: [tag.id] });
      expect(await ids(`tagId=${tag.id}`)).toEqual([other.id]);

      const since = new Date().toISOString();
      await send("PATCH", `/v1/catalog/products/${other.id}`, {
        version: other.version,
        archived: true,
      });
      expect(await ids(`updatedSince=${encodeURIComponent(since)}&archived=all`)).toEqual([
        other.id,
      ]);
      expect(await ids("archived=true")).toEqual([other.id]);
      expect(await ids("")).toEqual([p.id]);
    } finally {
      tenantId = T;
    }
  });

  it("units and conversions", async () => {
    const each = await json<{ id: string }>(
      await send("POST", "/v1/catalog/units", { code: "ea", name: "Each" }),
    );
    const box = await json<{ id: string }>(
      await send("POST", "/v1/catalog/units", { code: "box", name: "Box", decimals: 0 }),
    );
    const conv = await send("POST", "/v1/catalog/unit-conversions", {
      fromUnitId: box.id,
      toUnitId: each.id,
      factor: "12",
    });
    expect(conv.status).toBe(201);
    const dup = await send("POST", "/v1/catalog/units", { code: "box", name: "Box again" });
    expect(dup.status).toBe(409);
    const list = await json<{ conversions: { factor: string }[] }>(
      await send("GET", "/v1/catalog/units"),
    );
    expect(list.conversions[0]?.factor).toBe("12.000000");
  });
});
