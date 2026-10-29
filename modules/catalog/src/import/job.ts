import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { withTenantTx } from "@wise-biz/db";
import { tenantKey } from "@wise-biz/storage";
import { parse } from "csv-parse";

import { productEventsFor } from "../application/products.ts";

import { COLUMNS, parseRow, reportCsv } from "./rows.ts";

import type { ImportRow, RowError } from "./rows.ts";
import type { OutboxEvent, TxHandle } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";
import type { ObjectStore } from "@wise-biz/storage";
import type pg from "pg";

export const BATCH = 500;
/** Row errors kept on the import row (and so in the report). More than this and the file is not worth reading on. */
export const MAX_ERRORS = 10_000;

export interface ImportJobDeps {
  /** wb_worker pool (ADR 0012). */
  pool: pg.Pool;
  store: ObjectStore;
  ids: { uuidv7(): string };
  clock: { now(): number };
}

interface ImportRecord {
  status: string;
  sha256: string;
  size_bytes: number;
  source_key: string;
  next_row: number;
  created_by: string;
}

const PG_CONSTRAINT = new Set(["23505", "23503", "23514"]);

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Runs (or resumes) one import. Each batch of BATCH rows is its own tenant-scoped transaction: validate in bulk
 * (`= any($1)` lookups), write the clean rows, emit their catalog events, record progress. A session advisory lock on a
 * dedicated connection keeps two workers off the same import; a crash releases it and the next run resumes at next_row.
 */
export async function runImport(
  deps: ImportJobDeps,
  tenantId: string,
  importId: string,
): Promise<void> {
  const lock = await deps.pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(
      "select pg_try_advisory_lock(hashtextextended('catalog.import:' || $1, 0)) as ok",
      [importId],
    );
    if (got.rows[0]?.ok !== true) return;
    try {
      await run(deps, tenantId, importId);
    } finally {
      await lock.query("select pg_advisory_unlock(hashtextextended('catalog.import:' || $1, 0))", [
        importId,
      ]);
    }
  } finally {
    lock.release();
  }
}

async function run(deps: ImportJobDeps, tenantId: string, importId: string): Promise<void> {
  const scope = { tenantId, requestId: importId };
  const tx = <T>(fn: (t: TxHandle) => Promise<T>) => withTenantTx(deps.pool, scope, fn);
  const now = () => new Date(deps.clock.now());

  const rec = await tx(async (t) => {
    const r = await t.query<ImportRecord>(
      `select status, sha256, size_bytes, source_key, next_row, created_by from catalog.imports
       where tenant_id = $1 and id = $2 for update`,
      [tenantId, importId],
    );
    const row = r.rows[0];
    if (row === undefined || (row.status !== "queued" && row.status !== "running"))
      return undefined;
    await t.query(
      `update catalog.imports set status = 'running', started_at = coalesce(started_at, $3)
       where tenant_id = $1 and id = $2`,
      [tenantId, importId, now()],
    );
    return row;
  });
  if (rec === undefined) return;

  const fail = (failure: string) =>
    tx((t) =>
      t.query(
        `update catalog.imports set status = 'failed', failure = $3, finished_at = $4 where tenant_id = $1 and id = $2`,
        [tenantId, importId, failure, now()],
      ),
    );

  const stream = await deps.store.get(rec.source_key);
  if (stream === null) {
    await fail("The file was not uploaded.");
    return;
  }
  const bytes = await readAll(stream, rec.size_bytes);
  if (
    bytes?.length !== rec.size_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== rec.sha256
  ) {
    {
      await fail("The uploaded file does not match its size and hash.");
      return;
    }
  }

  const ctx: CommandContext = {
    tenant: { tenantId, userId: rec.created_by, requestId: importId },
    userId: rec.created_by,
    requestId: importId,
    now: now(),
    ids: deps.ids,
  };
  const categories = await tx((t) => categoryIndex(t, tenantId));

  let header: string[] = [];
  const parser = Readable.from([bytes]).pipe(
    parse({
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      columns: (h: string[]) => (header = h.map((x) => x.trim().toLowerCase())),
    }),
  );
  const seenSku = new Set<string>();
  const seenCode = new Set<string>();
  let batch: { row: number; rec: Record<string, string> }[] = [];
  let row = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    await tx((t) => processBatch(t, ctx, importId, current, { seenSku, seenCode, categories }));
  };
  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    if (row === 0 && !(header.includes("product") && header.includes("sku"))) {
      {
        await fail(`Missing columns. Expected a header with: ${COLUMNS.join(", ")}.`);
        return;
      }
    }
    row++;
    if (row <= rec.next_row) {
      // Already committed by an earlier run: only rebuild the in-file duplicate sets.
      const p = parseRow(row, record);
      if (!Array.isArray(p)) {
        seenSku.add(p.sku.toLowerCase());
        for (const b of p.barcodes) seenCode.add(b.code);
      }
      continue;
    }
    batch.push({ row, rec: record });
    if (batch.length === BATCH) await flush();
  }
  await flush();

  await tx(async (t) => {
    const r = await t.query<{ errors: RowError[] }>(
      "select errors from catalog.imports where tenant_id = $1 and id = $2",
      [tenantId, importId],
    );
    const reportKey = tenantKey(tenantId, "imports", importId, "report.csv");
    await deps.store.put(reportKey, reportCsv(r.rows[0]?.errors ?? []), "text/csv");
    await t.query(
      `update catalog.imports set status = 'done', total_rows = $3, report_key = $4, finished_at = $5
       where tenant_id = $1 and id = $2`,
      [tenantId, importId, row, reportKey, now()],
    );
  });
}

/** "drinks > soda" -> category id, for every category of the tenant (trees are small). */
async function categoryIndex(tx: TxHandle, tenantId: string): Promise<Map<string, string>> {
  const r = await tx.query<{ id: string; names: string[] }>(
    `select leaf.id, array(select c.name from unnest(leaf.path) with ordinality p(id, n)
                           join catalog.categories c on c.tenant_id = leaf.tenant_id and c.id = p.id order by p.n) as names
     from catalog.categories leaf where leaf.tenant_id = $1`,
    [tenantId],
  );
  return new Map(r.rows.map((c) => [c.names.map((n) => n.toLowerCase()).join(" > "), c.id]));
}

interface Seen {
  seenSku: Set<string>;
  seenCode: Set<string>;
  categories: Map<string, string>;
}
interface Resolved extends ImportRow {
  unitId: string | null;
  categoryId: string | null;
  tagIds: string[];
  existing: { id: string; productId: string } | null;
}

async function processBatch(
  tx: TxHandle,
  ctx: CommandContext,
  importId: string,
  batch: readonly { row: number; rec: Record<string, string> }[],
  seen: Seen,
): Promise<void> {
  const tenantId = ctx.tenant.tenantId;
  const errors: RowError[] = [];
  const rows: ImportRow[] = [];
  for (const { row, rec } of batch) {
    const p = parseRow(row, rec);
    if (Array.isArray(p)) {
      errors.push(...p);
      continue;
    }
    const sku = p.sku.toLowerCase();
    if (seen.seenSku.has(sku)) {
      errors.push({ row, column: "sku", error: "This SKU is listed twice in the file." });
      continue;
    }
    const dup = p.barcodes.find((b) => seen.seenCode.has(b.code));
    if (dup !== undefined) {
      errors.push({
        row,
        column: "barcode",
        error: `Barcode ${dup.code} is listed twice in the file.`,
      });
      continue;
    }
    seen.seenSku.add(sku);
    for (const b of p.barcodes) seen.seenCode.add(b.code);
    rows.push(p);
  }

  // References and conflicts, one query each for the whole batch.
  // One connection: the four lookups run back to back (pg does not pipeline on one client).
  const units = await tx.query<{ code: string; id: string }>(
    "select code, id from catalog.units where tenant_id = $1 and code = any($2)",
    [tenantId, [...new Set(rows.flatMap((r) => (r.unit === null ? [] : [r.unit])))]],
  );
  const tags = await tx.query<{ name: string; id: string }>(
    "select lower(name) as name, id from catalog.tags where tenant_id = $1 and lower(name) = any($2)",
    [tenantId, [...new Set(rows.flatMap((r) => r.tags.map((t) => t.toLowerCase())))]],
  );
  const variants = await tx.query<{ sku: string; id: string; product_id: string }>(
    "select sku, id, product_id from catalog.variants where tenant_id = $1 and sku = any($2)",
    [tenantId, rows.map((r) => r.sku)],
  );
  const codes = await tx.query<{ code: string; variant_id: string }>(
    "select code, variant_id from catalog.barcodes where tenant_id = $1 and code = any($2)",
    [tenantId, rows.flatMap((r) => r.barcodes.map((b) => b.code))],
  );
  const unitBy = new Map(units.rows.map((u) => [u.code, u.id]));
  const tagBy = new Map(tags.rows.map((t) => [t.name, t.id]));
  const variantBy = new Map(variants.rows.map((v) => [v.sku, v]));
  const codeBy = new Map(codes.rows.map((c) => [c.code, c.variant_id]));

  const clean: Resolved[] = [];
  for (const r of rows) {
    const unitId = r.unit === null ? null : (unitBy.get(r.unit) ?? null);
    if (r.unit !== null && unitId === null) {
      errors.push({
        row: r.row,
        column: "unit",
        error: `Unknown unit "${r.unit}". Create it first.`,
      });
      continue;
    }
    const categoryId =
      r.category === null
        ? null
        : (seen.categories.get(r.category.map((c) => c.toLowerCase()).join(" > ")) ?? null);
    if (r.category !== null && categoryId === null) {
      errors.push({
        row: r.row,
        column: "category",
        error: `Unknown category "${r.category.join(" > ")}".`,
      });
      continue;
    }
    const missingTag = r.tags.find((t) => !tagBy.has(t.toLowerCase()));
    if (missingTag !== undefined) {
      errors.push({ row: r.row, column: "tags", error: `Unknown tag "${missingTag}".` });
      continue;
    }
    const v = variantBy.get(r.sku);
    const taken = r.barcodes.find((b) => {
      const holder = codeBy.get(b.code);
      return holder !== undefined && holder !== v?.id;
    });
    if (taken !== undefined) {
      errors.push({
        row: r.row,
        column: "barcode",
        error: `Barcode ${taken.code} belongs to another variant.`,
      });
      continue;
    }
    clean.push({
      ...r,
      unitId,
      categoryId,
      tagIds: r.tags.map((t) => tagBy.get(t.toLowerCase()) ?? ""),
      existing: v === undefined ? null : { id: v.id, productId: v.product_id },
    });
  }

  // Bulk write; a race with a concurrent edit (unique/FK) falls back to row by row, each in its own savepoint.
  const touched = new Set<string>();
  let ok = 0;
  await tx.query("savepoint batch");
  try {
    for (const id of await writeRows(tx, ctx, clean)) touched.add(id);
    ok = clean.length;
    await tx.query("release savepoint batch");
  } catch (e) {
    if (!PG_CONSTRAINT.has((e as { code?: string }).code ?? "")) throw e;
    await tx.query("rollback to savepoint batch");
    for (const r of clean) {
      await tx.query("savepoint one");
      try {
        for (const id of await writeRows(tx, ctx, [r])) touched.add(id);
        ok++;
        await tx.query("release savepoint one");
      } catch (err) {
        if (!PG_CONSTRAINT.has((err as { code?: string }).code ?? "")) throw err;
        await tx.query("rollback to savepoint one");
        errors.push({
          row: r.row,
          column: "sku",
          error: "Conflicts with a change made during the import.",
        });
      }
    }
  }

  const events: OutboxEvent[] = await productEventsFor(tx, ctx, [...touched]);
  await appendOutbox(tx, events);
  errors.sort((a, b) => a.row - b.row);
  await tx.query(
    `update catalog.imports set
       next_row = $3, ok_rows = ok_rows + $4, error_rows = error_rows + $5,
       errors = case when jsonb_array_length(errors) >= ${String(MAX_ERRORS)} then errors
                     else errors || $6::jsonb end
     where tenant_id = $1 and id = $2`,
    [tenantId, importId, batch.at(-1)?.row ?? 0, ok, errors.length, JSON.stringify(errors)],
  );
}

async function appendOutbox(tx: TxHandle, events: readonly OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  const tenantId = (events[0]?.payload as { tenantId: string }).tenantId;
  await tx.query(
    `insert into infra.outbox (tenant_id, id, topic, key, type, version, payload)
     select $1, e.id, e.topic, e.key, e.type, e.version, e.payload
     from jsonb_to_recordset($2::jsonb) as e(id uuid, topic text, key text, type text, version int, payload jsonb)`,
    [tenantId, JSON.stringify(events)],
  );
}

/** Writes resolved rows: new products (grouped by name, reusing an active product of that name), new variants,
 * updates to existing variants, new barcodes. Returns the product ids touched. */
async function writeRows(
  tx: TxHandle,
  ctx: CommandContext,
  rows: readonly Resolved[],
): Promise<string[]> {
  if (rows.length === 0) return [];
  const tenantId = ctx.tenant.tenantId;
  const fresh = rows.filter((r) => r.existing === null);
  const names = [...new Set(fresh.map((r) => r.product.toLowerCase()))];
  const existing = await tx.query<{ name: string; id: string }>(
    `select distinct on (lower(name)) lower(name) as name, id from catalog.products
     where tenant_id = $1 and archived_at is null and lower(name) = any($2) order by lower(name), id`,
    [tenantId, names],
  );
  const productBy = new Map(existing.rows.map((p) => [p.name, p.id]));
  const newProducts: Resolved[] = [];
  for (const r of fresh) {
    const key = r.product.toLowerCase();
    if (!productBy.has(key)) {
      productBy.set(key, ctx.ids.uuidv7());
      newProducts.push(r);
    }
  }
  if (newProducts.length > 0) {
    await tx.query(
      `insert into catalog.products (id, tenant_id, name, category_id, created_at, created_by, updated_at, updated_by)
       select x.id, $1, x.name, x.category_id, $2, $3, $2, $3
       from unnest($4::uuid[], $5::text[], $6::uuid[]) as x(id, name, category_id)`,
      [
        tenantId,
        ctx.now,
        ctx.userId,
        newProducts.map((r) => productBy.get(r.product.toLowerCase())),
        newProducts.map((r) => r.product),
        newProducts.map((r) => r.categoryId),
      ],
    );
    const links = newProducts.flatMap((r) =>
      r.tagIds.map((t) => [productBy.get(r.product.toLowerCase()), t]),
    );
    if (links.length > 0) {
      await tx.query(
        `insert into catalog.product_tags (tenant_id, product_id, tag_id)
         select $1, x.p, x.t from unnest($2::uuid[], $3::uuid[]) as x(p, t) on conflict do nothing`,
        [tenantId, links.map((l) => l[0]), links.map((l) => l[1])],
      );
    }
  }
  const variantId = new Map<Resolved, string>();
  if (fresh.length > 0) {
    for (const r of fresh) variantId.set(r, ctx.ids.uuidv7());
    await tx.query(
      `insert into catalog.variants (id, tenant_id, product_id, sku, name, unit_id, tracks_batches, tax_category,
         created_at, created_by, updated_at, updated_by)
       select x.id, $1, x.product_id, x.sku, x.name, x.unit_id, x.tracks, x.tax, $2, $3, $2, $3
       from unnest($4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::uuid[], $9::boolean[], $10::text[])
         as x(id, product_id, sku, name, unit_id, tracks, tax)`,
      [
        tenantId,
        ctx.now,
        ctx.userId,
        fresh.map((r) => variantId.get(r)),
        fresh.map((r) => productBy.get(r.product.toLowerCase())),
        fresh.map((r) => r.sku),
        fresh.map((r) => r.variant),
        fresh.map((r) => r.unitId),
        fresh.map((r) => r.tracksBatches),
        fresh.map((r) => r.taxCategory),
      ],
    );
  }
  const updates = rows.filter((r) => r.existing !== null);
  if (updates.length > 0) {
    await tx.query(
      `update catalog.variants v set name = x.name, unit_id = x.unit_id, tracks_batches = x.tracks,
         tax_category = x.tax, version = v.version + 1, updated_at = $2, updated_by = $3
       from unnest($4::uuid[], $5::text[], $6::uuid[], $7::boolean[], $8::text[]) as x(id, name, unit_id, tracks, tax)
       where v.tenant_id = $1 and v.id = x.id`,
      [
        tenantId,
        ctx.now,
        ctx.userId,
        updates.map((r) => r.existing?.id),
        updates.map((r) => r.variant),
        updates.map((r) => r.unitId),
        updates.map((r) => r.tracksBatches),
        updates.map((r) => r.taxCategory),
      ],
    );
  }
  const codes = rows.flatMap((r) => {
    const vid = r.existing?.id ?? variantId.get(r) ?? "";
    return r.barcodes.map((b) => [vid, b.code, b.format] as const);
  });
  if (codes.length > 0) {
    // A code already on this same variant is a no-op (re-import of the same row).
    await tx.query(
      `insert into catalog.barcodes (tenant_id, variant_id, code, format)
       select $1, x.v, x.c, x.f from unnest($2::uuid[], $3::text[], $4::text[]) as x(v, c, f)
       where not exists (select 1 from catalog.barcodes b where b.tenant_id = $1 and b.code = x.c and b.variant_id = x.v)`,
      [tenantId, codes.map((c) => c[0]), codes.map((c) => c[1]), codes.map((c) => c[2])],
    );
  }
  const touched = new Set<string>();
  for (const r of rows)
    touched.add(r.existing?.productId ?? productBy.get(r.product.toLowerCase()) ?? "");
  await tx.query(
    "update catalog.products set updated_at = $2, updated_by = $3 where tenant_id = $1 and id = any($4::uuid[])",
    [tenantId, ctx.now, ctx.userId, [...touched]],
  );
  return [...touched];
}
