import { normaliseBarcodes } from "../domain/barcode.ts";
import {
  BarcodeChangedV1,
  ProductUpsertedV1,
  VariantArchivedV1,
  VariantUpsertedV1,
} from "../events.ts";

import { getProduct, VARIANT_COLUMNS, variantDto } from "./queries.ts";
import { catalogEvent, notFound, stale } from "./shared.ts";

import type { VariantRow } from "./queries.ts";
import type { BarcodeFormat } from "../domain/barcode.ts";
import type {
  CreateProductInput,
  UpdateProductInput,
  UpdateVariantInput,
  VariantInput,
} from "../schemas.ts";
import type { OutboxEvent, TxHandle } from "@wise-biz/db";
import type { CommandContext, CommandResult } from "@wise-biz/module-kit";

const ALL = new Set(["variants", "barcodes", "media"] as const);

interface Snapshot {
  productId: string;
  name: string;
  categoryId: string | null;
  categoryPath: string[];
  tags: string[];
  archived: boolean;
  variants: (VariantRow & { barcodes: string[] })[];
}

/**
 * Everything the catalog events carry, for many products in TWO queries (consumers never read our tables). Read inside
 * the command transaction, after the writes.
 */
async function snapshots(
  tx: TxHandle,
  tenantId: string,
  productIds: readonly string[],
): Promise<Snapshot[]> {
  if (productIds.length === 0) return [];
  const p = await tx.query<{
    id: string;
    name: string;
    category_id: string | null;
    archived: boolean;
    category_path: string[];
    tags: string[];
  }>(
    `select p.id, p.name, p.category_id, p.archived_at is not null as archived,
       coalesce((select array_agg(c.name order by array_position(leaf.path, c.id))
                 from catalog.categories leaf
                 join catalog.categories c on c.tenant_id = leaf.tenant_id and c.id = any(leaf.path)
                 where leaf.tenant_id = p.tenant_id and leaf.id = p.category_id), '{}') as category_path,
       coalesce((select array_agg(t.name order by lower(t.name))
                 from catalog.product_tags pt join catalog.tags t on t.tenant_id = pt.tenant_id and t.id = pt.tag_id
                 where pt.tenant_id = p.tenant_id and pt.product_id = p.id), '{}') as tags
     from catalog.products p where p.tenant_id = $1 and p.id = any($2::uuid[]) order by p.id`,
    [tenantId, productIds],
  );
  const v = await tx.query<VariantRow & { barcodes: string[] }>(
    `select ${VARIANT_COLUMNS},
       coalesce((select array_agg(b.code order by b.code) from catalog.barcodes b
                 where b.tenant_id = v.tenant_id and b.variant_id = v.id), '{}') as barcodes
     from catalog.variants v where v.tenant_id = $1 and v.product_id = any($2::uuid[])
     order by v.product_id, v.id`,
    [tenantId, productIds],
  );
  const byProduct = new Map<string, (VariantRow & { barcodes: string[] })[]>();
  for (const row of v.rows) {
    const list = byProduct.get(row.product_id);
    if (list === undefined) byProduct.set(row.product_id, [row]);
    else list.push(row);
  }
  return p.rows.map((row) => ({
    productId: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryPath: row.category_path,
    tags: row.tags,
    archived: row.archived,
    variants: byProduct.get(row.id) ?? [],
  }));
}

async function snapshot(tx: TxHandle, tenantId: string, productId: string): Promise<Snapshot> {
  return (await snapshots(tx, tenantId, [productId]))[0] ?? notFound();
}

/** Re-emits product + variant upserts (after a category rename or move changed their categoryPath). */
export async function productEventsFor(
  tx: TxHandle,
  ctx: CommandContext,
  productIds: readonly string[],
): Promise<OutboxEvent[]> {
  const list = await snapshots(tx, ctx.tenant.tenantId, productIds);
  return list.flatMap((s) => [productEvent(ctx, s), ...variantEvents(ctx, s)]);
}

const productEvent = (ctx: CommandContext, s: Snapshot): OutboxEvent =>
  catalogEvent(ProductUpsertedV1, ctx, `product/${s.productId}`, {
    productId: s.productId,
    name: s.name,
    categoryId: s.categoryId,
    categoryPath: s.categoryPath,
    tags: s.tags,
    archived: s.archived,
  });

/** A variant of an archived product is not sellable either, so `archived` is the effective state. */
const variantEvents = (
  ctx: CommandContext,
  s: Snapshot,
  only?: ReadonlySet<string>,
): OutboxEvent[] =>
  s.variants
    .filter((v) => only === undefined || only.has(v.id))
    .map((v) =>
      catalogEvent(VariantUpsertedV1, ctx, `variant/${v.id}`, {
        productId: s.productId,
        variantId: v.id,
        productName: s.name,
        name: v.name,
        sku: v.sku,
        barcodes: v.barcodes,
        unitId: v.unit_id,
        taxCategory: v.tax_category,
        tracksBatches: v.tracks_batches,
        categoryPath: s.categoryPath,
        tags: s.tags,
        archived: v.archived || s.archived,
      }),
    );

async function insertVariant(
  tx: TxHandle,
  ctx: CommandContext,
  productId: string,
  v: VariantInput,
): Promise<string> {
  const tenantId = ctx.tenant.tenantId;
  const id = v.id ?? ctx.ids.uuidv7();
  await tx.query(
    `insert into catalog.variants (id, tenant_id, product_id, sku, name, unit_id, tracks_batches, tax_category,
       attributes, created_at, created_by, updated_at, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $11)`,
    [
      id,
      tenantId,
      productId,
      v.sku,
      v.name,
      v.unitId ?? null,
      v.tracksBatches ?? false,
      v.taxCategory ?? "standard",
      JSON.stringify(v.attributes ?? {}),
      ctx.now,
      ctx.userId,
    ],
  );
  await insertBarcodes(tx, ctx, id, normaliseBarcodes(v.barcodes ?? []));
  return id;
}

async function insertBarcodes(
  tx: TxHandle,
  ctx: CommandContext,
  variantId: string,
  list: readonly { code: string; format: BarcodeFormat }[],
): Promise<void> {
  if (list.length === 0) return;
  await tx.query(
    `insert into catalog.barcodes (id, tenant_id, variant_id, code, format, created_at)
     select x.id, $1, $2, x.code, x.format, $3
     from unnest($4::uuid[], $5::text[], $6::text[]) as x(id, code, format)`,
    [
      ctx.tenant.tenantId,
      variantId,
      ctx.now,
      list.map(() => ctx.ids.uuidv7()),
      list.map((b) => b.code),
      list.map((b) => b.format),
    ],
  );
}

async function setTags(
  tx: TxHandle,
  tenantId: string,
  productId: string,
  tagIds: readonly string[],
): Promise<void> {
  await tx.query("delete from catalog.product_tags where tenant_id = $1 and product_id = $2", [
    tenantId,
    productId,
  ]);
  if (tagIds.length === 0) return;
  await tx.query(
    `insert into catalog.product_tags (tenant_id, product_id, tag_id)
     select $1, $2, t from unnest($3::uuid[]) as t on conflict do nothing`,
    [tenantId, productId, [...new Set(tagIds)]],
  );
}

const touchProduct = (tx: TxHandle, ctx: CommandContext, productId: string) =>
  tx.query(
    "update catalog.products set updated_at = $3, updated_by = $4 where tenant_id = $1 and id = $2",
    [ctx.tenant.tenantId, productId, ctx.now, ctx.userId],
  );

/** A product with its first variants (and their barcodes) in one transaction. */
export async function createProductCommand(
  tx: TxHandle,
  ctx: CommandContext,
  input: CreateProductInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const id = input.id ?? ctx.ids.uuidv7();
  await tx.query(
    `insert into catalog.products (id, tenant_id, name, description, category_id, created_at, created_by,
       updated_at, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $6, $7)`,
    [
      id,
      tenantId,
      input.name,
      input.description ?? null,
      input.categoryId ?? null,
      ctx.now,
      ctx.userId,
    ],
  );
  await setTags(tx, tenantId, id, input.tagIds ?? []);
  for (const v of input.variants) await insertVariant(tx, ctx, id, v);
  const s = await snapshot(tx, tenantId, id);
  const body = (await getProduct(tx, tenantId, id, ALL)) ?? notFound();
  return {
    status: 201,
    body,
    audit: [
      { action: "catalog.product.created", entity: "catalog.product", entityId: id, after: body },
    ],
    events: [productEvent(ctx, s), ...variantEvents(ctx, s)],
  };
}

export async function updateProductCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  input: UpdateProductInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const before = (await getProduct(tx, tenantId, id, new Set())) ?? notFound();
  const u = await tx.query(
    `update catalog.products set
       name = coalesce($4, name),
       description = case when $5::boolean then $6 else description end,
       category_id = case when $7::boolean then $8::uuid else category_id end,
       archived_at = case when $9::boolean is null then archived_at
                          when $9 then coalesce(archived_at, $10) else null end,
       version = version + 1, updated_at = $10, updated_by = $11
     where tenant_id = $1 and id = $2 and version = $3`,
    [
      tenantId,
      id,
      input.version,
      input.name ?? null,
      input.description !== undefined,
      input.description ?? null,
      input.categoryId !== undefined,
      input.categoryId ?? null,
      input.archived ?? null,
      ctx.now,
      ctx.userId,
    ],
  );
  if (u.rowCount !== 1) stale();
  if (input.tagIds !== undefined) await setTags(tx, tenantId, id, input.tagIds);
  const s = await snapshot(tx, tenantId, id);
  const after = (await getProduct(tx, tenantId, id, new Set())) ?? notFound();
  const archivedNow = !before.archived && after.archived;
  return {
    status: 200,
    body: after,
    audit: [
      {
        action: archivedNow ? "catalog.product.archived" : "catalog.product.updated",
        entity: "catalog.product",
        entityId: id,
        before,
        after,
      },
    ],
    // Product name, category and tags are part of every variant's search document, so all variants are re-emitted.
    events: [
      productEvent(ctx, s),
      ...variantEvents(ctx, s),
      ...(archivedNow
        ? s.variants
            .filter((v) => !v.archived)
            .map((v) =>
              catalogEvent(VariantArchivedV1, ctx, `variant/${v.id}`, {
                productId: id,
                variantId: v.id,
              }),
            )
        : []),
    ],
  };
}

export async function addVariantCommand(
  tx: TxHandle,
  ctx: CommandContext,
  productId: string,
  input: VariantInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const exists = await tx.query(
    "select 1 from catalog.products where tenant_id = $1 and id = $2 for update",
    [tenantId, productId],
  );
  if (exists.rowCount !== 1) notFound();
  const id = await insertVariant(tx, ctx, productId, input);
  await touchProduct(tx, ctx, productId);
  const s = await snapshot(tx, tenantId, productId);
  const v = s.variants.find((x) => x.id === id) ?? notFound();
  const body = { ...variantDto(v), barcodes: await barcodesOf(tx, tenantId, id) };
  return {
    status: 201,
    body,
    audit: [
      { action: "catalog.variant.created", entity: "catalog.variant", entityId: id, after: body },
    ],
    events: variantEvents(ctx, s, new Set([id])),
  };
}

async function barcodesOf(tx: TxHandle, tenantId: string, variantId: string) {
  const r = await tx.query<{ code: string; format: string }>(
    "select code, format from catalog.barcodes where tenant_id = $1 and variant_id = $2 order by code",
    [tenantId, variantId],
  );
  return r.rows;
}

async function lockVariant(tx: TxHandle, tenantId: string, id: string): Promise<VariantRow> {
  const r = await tx.query<VariantRow>(
    `select ${VARIANT_COLUMNS} from catalog.variants v where v.tenant_id = $1 and v.id = $2 for update`,
    [tenantId, id],
  );
  return r.rows[0] ?? notFound();
}

export async function updateVariantCommand(
  tx: TxHandle,
  ctx: CommandContext,
  id: string,
  input: UpdateVariantInput,
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const before = await lockVariant(tx, tenantId, id);
  if (before.version !== input.version) stale();
  await tx.query(
    `update catalog.variants set
       sku = coalesce($3, sku), name = coalesce($4, name),
       unit_id = case when $5::boolean then $6::uuid else unit_id end,
       tracks_batches = coalesce($7, tracks_batches), tax_category = coalesce($8, tax_category),
       attributes = coalesce($9::jsonb, attributes),
       archived_at = case when $10::boolean is null then archived_at
                          when $10 then coalesce(archived_at, $11) else null end,
       version = version + 1, updated_at = $11, updated_by = $12
     where tenant_id = $1 and id = $2`,
    [
      tenantId,
      id,
      input.sku ?? null,
      input.name ?? null,
      input.unitId !== undefined,
      input.unitId ?? null,
      input.tracksBatches ?? null,
      input.taxCategory ?? null,
      input.attributes === undefined ? null : JSON.stringify(input.attributes),
      input.archived ?? null,
      ctx.now,
      ctx.userId,
    ],
  );
  await touchProduct(tx, ctx, before.product_id);
  const s = await snapshot(tx, tenantId, before.product_id);
  const after = s.variants.find((x) => x.id === id) ?? notFound();
  const archivedNow = !before.archived && after.archived;
  const body = { ...variantDto(after), barcodes: await barcodesOf(tx, tenantId, id) };
  return {
    status: 200,
    body,
    audit: [
      {
        action: archivedNow ? "catalog.variant.archived" : "catalog.variant.updated",
        entity: "catalog.variant",
        entityId: id,
        before: variantDto(before),
        after: body,
      },
    ],
    events: [
      ...variantEvents(ctx, s, new Set([id])),
      ...(archivedNow
        ? [
            catalogEvent(VariantArchivedV1, ctx, `variant/${id}`, {
              productId: before.product_id,
              variantId: id,
            }),
          ]
        : []),
    ],
  };
}

/** Replaces the variant's barcode set (archived variants too: that is how a reserved code is released). */
export async function setBarcodesCommand(
  tx: TxHandle,
  ctx: CommandContext,
  variantId: string,
  input: { barcodes: { code: string; format?: BarcodeFormat | undefined }[] },
): Promise<CommandResult> {
  const tenantId = ctx.tenant.tenantId;
  const v = await lockVariant(tx, tenantId, variantId);
  const next = normaliseBarcodes(input.barcodes);
  const before = await barcodesOf(tx, tenantId, variantId);
  // Diff on (code, format): a format correction is a remove + add of the same code.
  const id = (b: { code: string; format: string }) => `${b.code} ${b.format}`;
  const keep = new Set(next.map(id));
  const had = new Set(before.map(id));
  const removed = before.filter((b) => !keep.has(id(b))).map((b) => b.code);
  const added = next.filter((b) => !had.has(id(b)));
  if (removed.length > 0) {
    await tx.query(
      "delete from catalog.barcodes where tenant_id = $1 and variant_id = $2 and code = any($3::text[])",
      [tenantId, variantId, removed],
    );
  }
  await insertBarcodes(tx, ctx, variantId, added);
  await touchProduct(tx, ctx, v.product_id);
  const s = await snapshot(tx, tenantId, v.product_id);
  const after = await barcodesOf(tx, tenantId, variantId);
  const changed = removed.length > 0 || added.length > 0;
  return {
    status: 200,
    body: { variantId, barcodes: after },
    audit: [
      {
        action: "catalog.barcodes.set",
        entity: "catalog.variant",
        entityId: variantId,
        before: before,
        after: after,
      },
    ],
    ...(changed
      ? {
          events: [
            catalogEvent(BarcodeChangedV1, ctx, `variant/${variantId}`, {
              productId: v.product_id,
              variantId,
              codes: after.map((b) => b.code),
              added: added.map((b) => b.code),
              removed,
            }),
            ...variantEvents(ctx, s, new Set([variantId])),
          ],
        }
      : { noEvents: true }),
  };
}
