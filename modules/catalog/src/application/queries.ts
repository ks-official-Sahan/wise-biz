import { DomainError } from "@wise-biz/errors";

import type { Include, ListProductsQuery, ProductDto, VariantDto } from "../schemas.ts";
import type { TxHandle } from "@wise-biz/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_LIMIT = 50;

/** Opaque keyset cursor: base64url of the last product id. */
export const encodeCursor = (id: string): string => Buffer.from(id, "utf8").toString("base64url");
export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!UUID.test(id)) {
    throw new DomainError("VALIDATION_FAILED", "invalid cursor", {
      fieldErrors: [{ path: "after", message: "invalid cursor" }],
    });
  }
  return id;
}

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  tag_ids: string[];
  version: number;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
}
export interface VariantRow {
  id: string;
  product_id: string;
  sku: string;
  name: string;
  unit_id: string | null;
  tracks_batches: boolean;
  tax_category: string;
  attributes: Record<string, unknown>;
  version: number;
  archived: boolean;
  updated_at: Date;
}
interface BarcodeRow {
  variant_id: string;
  code: string;
  format: string;
}
interface MediaRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  asset_key: string;
  position: number;
  alt: string | null;
}

const PRODUCT_COLUMNS = `p.id, p.name, p.description, p.category_id, p.version, p.archived_at is not null as archived,
  p.created_at, p.updated_at,
  coalesce((select array_agg(t.tag_id order by t.tag_id) from catalog.product_tags t
            where t.tenant_id = p.tenant_id and t.product_id = p.id), '{}') as tag_ids`;
export const VARIANT_COLUMNS = `v.id, v.product_id, v.sku, v.name, v.unit_id, v.tracks_batches, v.tax_category,
  v.attributes, v.version, v.archived_at is not null as archived, v.updated_at`;

const productDto = (r: ProductRow): ProductDto => ({
  id: r.id,
  name: r.name,
  description: r.description,
  categoryId: r.category_id,
  tagIds: r.tag_ids,
  version: r.version,
  archived: r.archived,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
export const variantDto = (r: VariantRow): VariantDto => ({
  id: r.id,
  productId: r.product_id,
  sku: r.sku,
  name: r.name,
  unitId: r.unit_id,
  tracksBatches: r.tracks_batches,
  taxCategory: r.tax_category,
  attributes: r.attributes,
  version: r.version,
  archived: r.archived,
  updatedAt: r.updated_at.toISOString(),
});

const group = <R, K extends keyof R>(rows: readonly R[], key: K): Map<R[K], R[]> => {
  const m = new Map<R[K], R[]>();
  for (const r of rows) {
    const list = m.get(r[key]);
    if (list === undefined) m.set(r[key], [r]);
    else list.push(r);
  }
  return m;
};

/**
 * Attaches the requested relations with ONE query per relation (`= any($ids)` on tenant-leading indexes), whatever the
 * page size: products + variants + barcodes + media = 4 queries.
 */
async function attach(
  tx: TxHandle,
  tenantId: string,
  rows: readonly ProductRow[],
  include: ReadonlySet<Include>,
): Promise<ProductDto[]> {
  const products = rows.map(productDto);
  if (products.length === 0) return products;
  const ids = products.map((p) => p.id);
  const wantVariants = include.has("variants") || include.has("barcodes");
  if (wantVariants) {
    const vr = await tx.query<VariantRow>(
      `select ${VARIANT_COLUMNS} from catalog.variants v
       where v.tenant_id = $1 and v.product_id = any($2::uuid[]) order by v.product_id, v.id`,
      [tenantId, ids],
    );
    const variants = vr.rows.map(variantDto);
    if (include.has("barcodes") && variants.length > 0) {
      const br = await tx.query<BarcodeRow>(
        `select variant_id, code, format from catalog.barcodes
         where tenant_id = $1 and variant_id = any($2::uuid[]) order by variant_id, code`,
        [tenantId, variants.map((v) => v.id)],
      );
      const byVariant = group(br.rows, "variant_id");
      for (const v of variants) {
        v.barcodes = (byVariant.get(v.id) ?? []).map((b) => ({ code: b.code, format: b.format }));
      }
    }
    const byProduct = group(variants, "productId");
    for (const p of products) p.variants = byProduct.get(p.id) ?? [];
  }
  if (include.has("media")) {
    const mr = await tx.query<MediaRow>(
      `select id, product_id, variant_id, asset_key, position, alt from catalog.product_media
       where tenant_id = $1 and product_id = any($2::uuid[]) order by product_id, position, id`,
      [tenantId, ids],
    );
    const byProduct = group(mr.rows, "product_id");
    for (const p of products) {
      p.media = (byProduct.get(p.id) ?? []).map((m) => ({
        id: m.id,
        variantId: m.variant_id,
        assetKey: m.asset_key,
        position: m.position,
        alt: m.alt,
      }));
    }
  }
  return products;
}

export const parseInclude = (raw: string | undefined): Set<Include> =>
  new Set((raw ?? "").split(",").filter((s): s is Include => s !== ""));

/**
 * Keyset page on (tenant_id, id). The WHERE clause is built from the filters actually given (no `$x is null or ...`
 * catch-alls), so the planner picks the partial active index, the category index or the updated_at index.
 */
export async function listProducts(
  tx: TxHandle,
  tenantId: string,
  q: ListProductsQuery,
): Promise<{ products: ProductDto[]; next: string | null }> {
  const limit = q.limit ?? DEFAULT_LIMIT;
  const params: unknown[] = [tenantId];
  const where = ["p.tenant_id = $1"];
  const add = (sql: (n: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${String(params.length)}`));
  };
  if (q.after !== undefined) add((n) => `p.id > ${n}::uuid`, decodeCursor(q.after));
  const archived = q.archived ?? "false";
  if (archived === "false") where.push("p.archived_at is null");
  if (archived === "true") where.push("p.archived_at is not null");
  if (q.categoryId !== undefined) {
    add(
      (n) =>
        `p.category_id in (select c.id from catalog.categories c where c.tenant_id = $1 and c.path @> array[${n}::uuid])`,
      q.categoryId,
    );
  }
  if (q.tagId !== undefined) {
    add(
      (n) =>
        `exists (select 1 from catalog.product_tags pt where pt.tenant_id = $1 and pt.product_id = p.id and pt.tag_id = ${n}::uuid)`,
      q.tagId,
    );
  }
  if (q.updatedSince !== undefined) add((n) => `p.updated_at >= ${n}::timestamptz`, q.updatedSince);
  params.push(limit + 1);
  const r = await tx.query<ProductRow>(
    `select ${PRODUCT_COLUMNS} from catalog.products p where ${where.join(" and ")}
     order by p.id limit $${String(params.length)}`,
    params,
  );
  const page = r.rows.slice(0, limit);
  const last = page.at(-1);
  const products = await attach(tx, tenantId, page, parseInclude(q.include));
  return {
    products,
    next: r.rows.length > limit && last !== undefined ? encodeCursor(last.id) : null,
  };
}

export async function getProduct(
  tx: TxHandle,
  tenantId: string,
  id: string,
  include: ReadonlySet<Include>,
): Promise<ProductDto | undefined> {
  const r = await tx.query<ProductRow>(
    `select ${PRODUCT_COLUMNS} from catalog.products p where p.tenant_id = $1 and p.id = $2`,
    [tenantId, id],
  );
  return (await attach(tx, tenantId, r.rows, include))[0];
}

/** Exact, indexed (barcodes_code_key). Archived variants and products are not sellable, so they are not found. */
export async function lookupBarcode(tx: TxHandle, tenantId: string, code: string) {
  const r = await tx.query<
    VariantRow & { code: string; format: string; p_name: string; p_category_id: string | null }
  >(
    `select b.code, b.format, ${VARIANT_COLUMNS}, p.name as p_name, p.category_id as p_category_id
     from catalog.barcodes b
     join catalog.variants v on v.tenant_id = b.tenant_id and v.id = b.variant_id
     join catalog.products p on p.tenant_id = v.tenant_id and p.id = v.product_id
     where b.tenant_id = $1 and b.code = $2 and v.archived_at is null and p.archived_at is null`,
    [tenantId, code],
  );
  const row = r.rows[0];
  if (row === undefined) return undefined;
  return {
    code: row.code,
    format: row.format,
    variant: variantDto(row),
    product: { id: row.product_id, name: row.p_name, categoryId: row.p_category_id },
  };
}
