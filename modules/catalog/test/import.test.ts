import { createHash } from "node:crypto";
import { join } from "node:path";

import { OpenAPIHono } from "@hono/zod-openapi";
import { createPool, migrate } from "@wise-biz/db";
import { DomainError, toProblem } from "@wise-biz/errors";
import { uuidv7 } from "@wise-biz/ids";
import { policyMiddleware } from "@wise-biz/module-kit";
import { createCatalog, matrixFromRows } from "@wise-biz/policy";
import { createMemoryStore } from "@wise-biz/storage";
import { testDatabase } from "@wise-biz/testing/containers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gs1CheckDigitOk } from "../src/domain/barcode.ts";
import { runImport } from "../src/import/job.ts";
import { csvCell, parseRow } from "../src/import/rows.ts";
import { createCatalogModule, createImportConsumer } from "../src/index.ts";

import type { AppEnv } from "@wise-biz/module-kit";
import type pg from "pg";

const dir = (m: string) => join(import.meta.dirname, "..", "..", m, "migrations");
const T = uuidv7();
const USER = uuidv7();
const store = createMemoryStore();
const catalogModule = createCatalogModule({ store });

let app: OpenAPIHono<AppEnv>;
let pool: pg.Pool;
let worker: pg.Pool;
let admin: pg.Pool;
let drop: () => Promise<void>;
const failures: unknown[] = [];

beforeAll(async () => {
  const db = await testDatabase();
  await migrate(db.url("migrator"), [
    { module: "infra", dir: dir("infra") },
    { module: "audit", dir: dir("audit") },
    { module: "catalog", dir: join(import.meta.dirname, "..", "migrations") },
  ]);
  pool = createPool(db.url("app"));
  worker = createPool(db.url("worker"));
  admin = createPool(db.url("admin"));
  drop = async () => {
    await Promise.all([pool.end(), worker.end(), admin.end()]);
    await db.drop();
  };
  const matrix = matrixFromRows(createCatalog(catalogModule.permissions), [
    { role: "owner", permission: "catalog:read" },
    { role: "owner", permission: "catalog:write" },
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
      userId: USER,
      sessionId: "01900000-0000-7000-8000-0000000000aa",
      tenantId: T,
      roles: ["owner"],
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
  catalogModule.routes(app, { pool, clock: { now: () => Date.now() }, ids: { uuidv7 } });

  // References the file points at (admin bypasses RLS).
  const drinks = uuidv7();
  const soda = uuidv7();
  await admin.query(
    `insert into catalog.units (tenant_id, code, name) values ($1, 'ea', 'Each'), ($1, 'kg', 'Kilogram');
     `.replace(/\$1/g, `'${T}'`),
  );
  await admin.query(
    "insert into catalog.categories (id, tenant_id, name, path) values ($1, $3, 'Drinks', array[$1::uuid]), ($2, $3, 'Soda', array[$1::uuid, $2::uuid])",
    [drinks, soda, T],
  );
  await admin.query("insert into catalog.tags (tenant_id, name) values ($1, 'Promo')", [T]);
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

const ean13 = (body12: string) => {
  for (let d = 0; d <= 9; d++)
    if (gs1CheckDigitOk(`${body12}${String(d)}`)) return `${body12}${String(d)}`;
  throw new Error("unreachable");
};

/** 10,000 rows, 37 bad: 10 wrong check digits, 8 unknown units, 7 SKUs repeated in the file, 6 unknown categories,
 * 6 rows without a product name. Two variants per product name. */
function file(): { text: string; bad: number } {
  const lines = ["product,variant,sku,barcode,unit,category,tags,tax_category,tracks_batches"];
  let bad = 0;
  for (let i = 1; i <= 10_000; i++) {
    let product = `Product ${String(Math.ceil(i / 2))}`;
    let sku = `IMP-${String(i).padStart(5, "0")}`;
    let barcode = ean13(`21${String(i).padStart(10, "0")}`);
    let unit = i % 3 === 0 ? "kg" : "ea";
    let category = i % 5 === 0 ? "Drinks > Soda" : "";
    if (i <= 10) barcode = `${barcode.slice(0, 12)}${String((Number(barcode.at(-1)) + 1) % 10)}`;
    else if (i <= 18) unit = "crate";
    else if (i <= 25) sku = "IMP-00100";
    else if (i <= 31) category = "Drinks > Juice";
    else if (i <= 37) product = "";
    if (i <= 37) bad++;
    lines.push(
      [
        product,
        i % 2 === 0 ? "B" : "A",
        sku,
        barcode,
        unit,
        category,
        i % 7 === 0 ? "promo" : "",
        "",
        i % 11 === 0 ? "yes" : "",
      ].join(","),
    );
  }
  return { text: lines.join("\n") + "\n", bad };
}

interface ImportDto {
  id: string;
  status: string;
  okRows: number;
  errorRows: number;
  totalRows: number;
  errors: { row: number; column: string }[];
  reportUrl: string | null;
  upload: { url: string } | null;
}

async function upload(text: string): Promise<{ res: Response; dto: ImportDto }> {
  const bytes = Buffer.from(text, "utf8");
  const res = await send("POST", "/v1/catalog/imports", {
    fileName: "items.csv",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const dto = await json<ImportDto>(res.clone());
  if (dto.upload !== null)
    await store.put(dto.upload.url.replace("memory://put/", ""), bytes, "text/csv");
  return { res, dto };
}

const deliverRequested = async (consumer: ReturnType<typeof createImportConsumer>) => {
  const r = await admin.query<{ payload: unknown }>(
    "select payload from infra.outbox where tenant_id = $1 and type = 'catalog.import.requested' order by id desc limit 1",
    [T],
  );
  await consumer.handle({ payload: r.rows[0]?.payload });
  await consumer.drain();
};

describe("rows", () => {
  it("validates shape and escapes formula cells in the report", () => {
    expect(parseRow(1, { product: "Tea", sku: "T-1" })).toMatchObject({
      variant: "Default",
      taxCategory: "standard",
    });
    expect(parseRow(2, { product: "", sku: "bad sku", tracks_batches: "maybe" })).toHaveLength(3);
    expect(
      parseRow(3, {
        product: "P",
        sku: "S-1",
        variant: "v".repeat(201),
        category: "Drinks >",
        tax_category: "Bad Tax",
        barcode: "4006381333932|ABC",
        unit: "KG",
        tags: "a| b |",
      }),
    ).toHaveLength(4);
    expect(
      parseRow(4, {
        product: "P",
        sku: "S-2",
        unit: "KG",
        tags: "a| b |",
        category: "A > B",
        tracks_batches: "YES",
      }),
    ).toMatchObject({ unit: "kg", tags: ["a", "b"], category: ["A", "B"], tracksBatches: true });
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(7)).toBe("7");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
  });
});

describe("import job", () => {
  it("10k rows with 37 bad: 9,963 upserted, all 37 reported; re-upload is a no-op", async () => {
    const consumer = createImportConsumer(
      { pool: worker, store, ids: { uuidv7 }, clock: { now: () => Date.now() } },
      (err) => failures.push(err),
    );
    const { text, bad } = file();
    const { res, dto } = await upload(text);
    expect(res.status).toBe(201);
    expect(dto.status).toBe("awaiting_upload");
    const started = await send("POST", `/v1/catalog/imports/${dto.id}/start`, {});
    expect(started.status).toBe(200);
    await deliverRequested(consumer);
    expect(failures).toEqual([]);

    const done = await json<ImportDto>(await send("GET", `/v1/catalog/imports/${dto.id}`));
    expect(done).toMatchObject({
      status: "done",
      totalRows: 10_000,
      okRows: 10_000 - bad,
      errorRows: bad,
    });
    const report = new TextDecoder().decode(
      store.objects.get(`tenants/${T}/imports/${dto.id}/report.csv`),
    );
    const reportRows = report.trim().split("\r\n").slice(1);
    expect(reportRows).toHaveLength(bad);
    expect(new Set(reportRows.map((l) => l.split(",")[1]))).toEqual(
      new Set(["barcode", "unit", "sku", "category", "product"]),
    );
    expect(done.reportUrl).toContain("report.csv");

    const counts = await admin.query<{ v: string; p: string; b: string; e: string }>(
      `select (select count(*) from catalog.variants where tenant_id = $1) as v,
              (select count(*) from catalog.products where tenant_id = $1) as p,
              (select count(*) from catalog.barcodes where tenant_id = $1) as b,
              (select count(*) from infra.outbox where tenant_id = $1 and type = 'catalog.variant.upserted') as e`,
      [T],
    );
    expect(Number(counts.rows[0]?.v)).toBe(10_000 - bad);
    expect(Number(counts.rows[0]?.b)).toBe(10_000 - bad);
    expect(Number(counts.rows[0]?.p)).toBeLessThan(10_000 - bad);
    expect(Number(counts.rows[0]?.e)).toBeGreaterThanOrEqual(10_000 - bad);

    // The same file again: the same import comes back, done; starting it again is refused; nothing changes.
    const again = await upload(text);
    expect(again.res.status).toBe(200);
    expect(again.dto).toMatchObject({ id: dto.id, status: "done", upload: null });
    expect((await send("POST", `/v1/catalog/imports/${dto.id}/start`, {})).status).toBe(409);
    const after = await admin.query<{ v: string }>(
      "select count(*) as v from catalog.variants where tenant_id = $1",
      [T],
    );
    expect(Number(after.rows[0]?.v)).toBe(10_000 - bad);
  }, 240_000);

  it("a changed file updates existing SKUs in place; a wrong hash fails the import", async () => {
    const text =
      "product,variant,sku,unit\nProduct 1,Renamed,IMP-00040,kg\nBrand new,Default,NEW-1,ea\n";
    const { dto } = await upload(text);
    await send("POST", `/v1/catalog/imports/${dto.id}/start`, {});
    await runImport(
      { pool: worker, store, ids: { uuidv7 }, clock: { now: () => Date.now() } },
      T,
      dto.id,
    );
    const v = await admin.query<{ name: string; version: number }>(
      "select name, version from catalog.variants where tenant_id = $1 and sku = 'IMP-00040'",
      [T],
    );
    expect(v.rows[0]).toEqual({ name: "Renamed", version: 2 });

    const bytes = "product,sku\nX,X-1\n";
    const res = await send("POST", "/v1/catalog/imports", {
      fileName: "x.csv",
      sizeBytes: bytes.length,
      sha256: "0".repeat(64),
    });
    const bad = await json<ImportDto>(res);
    await store.put(bad.upload?.url.replace("memory://put/", "") ?? "", bytes, "text/csv");
    await send("POST", `/v1/catalog/imports/${bad.id}/start`, {});
    await runImport(
      { pool: worker, store, ids: { uuidv7 }, clock: { now: () => Date.now() } },
      T,
      bad.id,
    );
    expect(await json(await send("GET", `/v1/catalog/imports/${bad.id}`))).toMatchObject({
      status: "failed",
      failure: expect.stringMatching(/hash/) as unknown,
    });
  });

  it("refuses unknown tags and taken barcodes per row; missing upload, bad header and a held lock", async () => {
    const deps = { pool: worker, store, ids: { uuidv7 }, clock: { now: () => Date.now() } };
    const taken = ean13("210000000040");
    const rows = `product,sku,tags,barcode\nT1,TAG-1,nosuch,\nT2,TAG-2,,${taken}\n`;
    const { dto } = await upload(rows);
    await send("POST", `/v1/catalog/imports/${dto.id}/start`, {});
    await runImport(deps, T, dto.id);
    const r = await json<ImportDto>(await send("GET", `/v1/catalog/imports/${dto.id}`));
    expect(r).toMatchObject({ status: "done", okRows: 0, errorRows: 2 });
    expect(r.errors.map((e) => e.column)).toEqual(["tags", "barcode"]);

    const startOnly = async (text: string, put: boolean) => {
      const bytes = Buffer.from(text);
      const created = await json<ImportDto>(
        await send("POST", "/v1/catalog/imports", {
          fileName: "f.csv",
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      );
      if (put)
        await store.put(created.upload?.url.replace("memory://put/", "") ?? "", bytes, "text/csv");
      await send("POST", `/v1/catalog/imports/${created.id}/start`, {});
      return created.id;
    };
    const missing = await startOnly("product,sku\nA,A-1\n", false);
    await runImport(deps, T, missing);
    expect(await json(await send("GET", `/v1/catalog/imports/${missing}`))).toMatchObject({
      status: "failed",
    });
    const header = await startOnly("name,code\nA,A-2\n", true);
    await runImport(deps, T, header);
    expect(await json(await send("GET", `/v1/catalog/imports/${header}`))).toMatchObject({
      status: "failed",
      failure: expect.stringMatching(/Missing columns/) as unknown,
    });

    // Another runner holds the lock: this run is a no-op and the import stays queued.
    const locked = await startOnly("product,sku\nL,L-1\n", true);
    const holder = await worker.connect();
    try {
      await holder.query("select pg_advisory_lock(hashtextextended('catalog.import:' || $1, 0))", [
        locked,
      ]);
      await runImport(deps, T, locked);
      expect(await json(await send("GET", `/v1/catalog/imports/${locked}`))).toMatchObject({
        status: "queued",
      });
    } finally {
      await holder.query("select pg_advisory_unlock_all()");
      holder.release();
    }
    expect((await send("GET", `/v1/catalog/imports/${uuidv7()}`)).status).toBe(404);
  });
});
