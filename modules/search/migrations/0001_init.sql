-- search: hybrid search projection (ADR 0007). Written only by the search consumer (wb_worker, inside a consumer tx
-- scoped to the event's tenant), read by the API (wb_app). Rebuildable from catalog events at any time.
--
-- Decisions:
--   * FTS uses the `simple` config: the tenant's language lives in tenancy, which this module cannot read, and
--     product names mix brands, sizes and languages (stemming "Coca-Cola" helps nobody). Typos and glued words are
--     the trigram's job on `norm`.
--   * `norm` = lowercase, punctuation removed, whitespace collapsed (search.norm). "Coca-Cola 1.5L" -> "cocacola 15l",
--     so the query "cocacola 1.5" ("cocacola 15") matches by word_similarity. Only punctuation and symbols are
--     removed (never letters or combining marks), so Sinhala/Tamil/Arabic names survive intact.
--   * `embedding vector` is nullable and dimensionless until P2 picks a model (no ANN index yet).
--   * Out-of-order safety: a document is only overwritten by an event at least as new (`source_time`).
CREATE SCHEMA search AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA search TO wb_app, wb_worker;

CREATE FUNCTION search.norm(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN btrim(regexp_replace(regexp_replace(lower(t), '[[:punct:]]+', '', 'g'), '[[:space:]]+', ' ', 'g'));

-- Title and SKU weigh most, then tags, then the category path.
CREATE FUNCTION search.doc_tsv(title text, sku text, tags text[], category_path text[]) RETURNS tsvector
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN setweight(to_tsvector('simple'::regconfig, title), 'A')
      || setweight(to_tsvector('simple'::regconfig, sku), 'A')
      || setweight(to_tsvector('simple'::regconfig, array_to_string(tags, ' ')), 'B')
      || setweight(to_tsvector('simple'::regconfig, array_to_string(category_path, ' ')), 'C');

CREATE TABLE search.search_documents (
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('variant')),
  entity_id uuid NOT NULL,
  product_id uuid NOT NULL,
  title text NOT NULL,
  sku text NOT NULL DEFAULT '',
  barcodes text[] NOT NULL DEFAULT '{}',
  category_path text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  archived boolean NOT NULL DEFAULT false,
  norm text GENERATED ALWAYS AS (search.norm(title || ' ' || sku)) STORED,
  -- Set by the projection (search.doc_tsv): array_to_string is STABLE, so it cannot be a generated column.
  tsv tsvector NOT NULL,
  embedding vector,
  source_time timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_documents_pkey PRIMARY KEY (tenant_id, kind, entity_id)
);
-- Product-level updates (rename, retag, archive) rewrite every variant document of the product.
CREATE INDEX search_documents_tenant_product_idx ON search.search_documents (tenant_id, product_id);
-- GIN cannot lead with tenant_id without btree_gin; every query adds tenant_id = $1 (and RLS does too).
CREATE INDEX search_documents_tsv_gin ON search.search_documents USING gin (tsv) WHERE NOT archived;
-- GiST, not GIN: the trigram leg is a KNN scan (ORDER BY norm <<-> query LIMIT n) that stops after n neighbours,
-- instead of rechecking every row that shares a common trigram (GIN at a low threshold did ~500 ms on 100k rows).
CREATE INDEX search_documents_norm_trgm ON search.search_documents USING gist (norm gist_trgm_ops) WHERE NOT archived;

ALTER TABLE "search"."search_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "search"."search_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "search"."search_documents" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- The API only reads; the consumer (tenant-scoped by app.tenant_id, so the same policy applies) maintains it.
REVOKE ALL ON search.search_documents FROM wb_app, wb_worker;
GRANT SELECT ON search.search_documents TO wb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON search.search_documents TO wb_worker;
GRANT EXECUTE ON FUNCTION search.norm(text) TO wb_app, wb_worker;
GRANT EXECUTE ON FUNCTION search.doc_tsv(text, text, text[], text[]) TO wb_worker;
