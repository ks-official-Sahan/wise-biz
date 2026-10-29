import type { TxHandle } from "@wise-biz/db";

/** Reciprocal rank fusion constant (Cormack et al.): dampens the head so two mid ranks beat one top rank. */
export const RRF_K = 60;
/** Candidates taken from each ranker before fusion. */
const DEPTH = 50;
/** Trigram neighbours farther than this (1 - word_similarity) are noise: typos like "coka" stay inside it. */
const MAX_DISTANCE = 0.7;

/** Same rule as search.norm() in SQL: lowercase, punctuation and symbols removed, whitespace collapsed. */
export const norm = (q: string): string =>
  q
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/** Prefix match on every token ("coca 1.5" -> "coca:* & 15:*"). Tokens hold no tsquery syntax after norm(). */
export const prefixQuery = (n: string): string =>
  n
    .split(" ")
    .filter((t) => t !== "")
    .map((t) => `${t}:*`)
    .join(" & ");

export interface SearchHit {
  variantId: string;
  productId: string;
  title: string;
  sku: string;
  barcodes: string[];
  score: number;
}

/**
 * Hybrid search over the tenant's sellable variants: FTS (prefix tsquery, ts_rank_cd) and a trigram KNN on the
 * normalised title + SKU (word-similarity distance), each capped at DEPTH candidates, fused by reciprocal rank. One
 * round trip.
 */
export async function searchVariants(
  tx: TxHandle,
  tenantId: string,
  q: string,
  limit: number,
): Promise<SearchHit[]> {
  const n = norm(q);
  if (n === "") return [];
  const r = await tx.query<{
    entity_id: string;
    product_id: string;
    title: string;
    sku: string;
    barcodes: string[];
    score: number;
  }>(
    `with fts as (
       select entity_id, row_number() over (order by rank desc, entity_id) as r from (
         select d.entity_id, ts_rank_cd(d.tsv, to_tsquery('simple', $2)) as rank
         from search.search_documents d
         where d.tenant_id = $1 and not d.archived and d.tsv @@ to_tsquery('simple', $2)
         order by rank desc limit ${String(DEPTH)}) x),
     trg as (
       select entity_id, row_number() over (order by dist, entity_id) as r from (
         select d.entity_id, $3 <<-> d.norm as dist
         from search.search_documents d
         where d.tenant_id = $1 and not d.archived
         order by $3 <<-> d.norm limit ${String(DEPTH)}) y
       where dist <= ${String(MAX_DISTANCE)}),
     fused as (
       select entity_id, sum(1.0 / (${String(RRF_K)} + r))::float8 as score
       from (select * from fts union all select * from trg) u group by entity_id)
     select d.entity_id, d.product_id, d.title, d.sku, d.barcodes, f.score
     from fused f
     join search.search_documents d on d.tenant_id = $1 and d.kind = 'variant' and d.entity_id = f.entity_id
     order by f.score desc, d.title, d.entity_id
     limit $4`,
    [tenantId, prefixQuery(n), n, limit],
  );
  return r.rows.map((row) => ({
    variantId: row.entity_id,
    productId: row.product_id,
    title: row.title,
    sku: row.sku,
    barcodes: row.barcodes,
    score: row.score,
  }));
}
