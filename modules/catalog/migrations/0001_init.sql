-- catalog: products the POS sells. Pattern from modules/_template (PK (tenant_id, id), composite FKs, tenant-leading
-- indexes, FORCE RLS, least-privilege grants).
--
-- Decisions:
--   * Categories are an adjacency list plus a materialised `path uuid[]` (root..self). Subtree filters use
--     `path @> array[$id]` on a GIN index. No ltree: its labels cannot hold UUIDs, and a uuid[] needs no extension. A
--     move rewrites the moved subtree's paths in one UPDATE (trees are small: hundreds of rows, depth <= 8).
--   * SKUs and barcodes are unique per tenant across ALL variants, archived included. Archiving keeps them reserved so
--     a restore never collides; to reuse a code, remove it from the archived variant first. Lookups skip archived rows.
--   * unit_id NULL means the implicit base unit "each". Quantities stay numeric(18,4) in the ledger modules.
--   * product_media rows exist now so `include=media` is real; uploads arrive with the media step.
CREATE SCHEMA catalog AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA catalog TO wb_app;

CREATE TABLE catalog.units (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z0-9_.-]{1,16}$'),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 60),
  decimals smallint NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT units_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT units_code_key UNIQUE (tenant_id, code)
);

-- 1 from_unit = factor to_unit (1 box = 12 each).
CREATE TABLE catalog.unit_conversions (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  from_unit_id uuid NOT NULL,
  to_unit_id uuid NOT NULL,
  factor numeric(18,6) NOT NULL CHECK (factor > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unit_conversions_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT unit_conversions_pair_key UNIQUE (tenant_id, from_unit_id, to_unit_id),
  CONSTRAINT unit_conversions_distinct CHECK (from_unit_id <> to_unit_id),
  CONSTRAINT unit_conversions_from_fk FOREIGN KEY (tenant_id, from_unit_id) REFERENCES catalog.units (tenant_id, id),
  CONSTRAINT unit_conversions_to_fk FOREIGN KEY (tenant_id, to_unit_id) REFERENCES catalog.units (tenant_id, id)
);
CREATE INDEX unit_conversions_tenant_to_idx ON catalog.unit_conversions (tenant_id, to_unit_id);

CREATE TABLE catalog.categories (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  parent_id uuid,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  path uuid[] NOT NULL CHECK (cardinality(path) BETWEEN 1 AND 8),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT categories_parent_fk FOREIGN KEY (tenant_id, parent_id) REFERENCES catalog.categories (tenant_id, id),
  CONSTRAINT categories_path_self CHECK (path[cardinality(path)] = id)
);
CREATE INDEX categories_tenant_parent_idx ON catalog.categories (tenant_id, parent_id);
-- Exception to "tenant_id leads": a GIN on uuid[] cannot lead with a scalar without btree_gin. Subtree queries always
-- add tenant_id = $1 (RLS too), and the array holds UUIDv7 ids that never repeat across tenants.
CREATE INDEX categories_path_gin ON catalog.categories USING gin (path);
-- Siblings have distinct names (case-insensitive); roots share the NULL parent bucket.
CREATE UNIQUE INDEX categories_sibling_name_key
  ON catalog.categories (tenant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE catalog.tags (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_pkey PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX tags_name_key ON catalog.tags (tenant_id, lower(name));

CREATE TABLE catalog.products (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  description text CHECK (length(description) <= 4000),
  category_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  CONSTRAINT products_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT products_category_fk FOREIGN KEY (tenant_id, category_id) REFERENCES catalog.categories (tenant_id, id)
);
-- Default list (active products, keyset on id) and the hot filters.
CREATE INDEX products_tenant_active_idx ON catalog.products (tenant_id, id) WHERE archived_at IS NULL;
CREATE INDEX products_tenant_category_idx ON catalog.products (tenant_id, category_id, id);
CREATE INDEX products_tenant_updated_idx ON catalog.products (tenant_id, updated_at, id);

CREATE TABLE catalog.product_tags (
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  CONSTRAINT product_tags_pkey PRIMARY KEY (tenant_id, product_id, tag_id),
  -- CASCADE: a tag link is an owned part of the product row (no life of its own).
  CONSTRAINT product_tags_product_fk FOREIGN KEY (tenant_id, product_id)
    REFERENCES catalog.products (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT product_tags_tag_fk FOREIGN KEY (tenant_id, tag_id) REFERENCES catalog.tags (tenant_id, id)
);
CREATE INDEX product_tags_tenant_tag_idx ON catalog.product_tags (tenant_id, tag_id, product_id);

CREATE TABLE catalog.variants (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  sku text NOT NULL CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  unit_id uuid,
  tracks_batches boolean NOT NULL DEFAULT false,
  tax_category text NOT NULL DEFAULT 'standard' CHECK (tax_category ~ '^[a-z][a-z0-9_]{0,31}$'),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  CONSTRAINT variants_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT variants_sku_key UNIQUE (tenant_id, sku),
  CONSTRAINT variants_product_fk FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products (tenant_id, id),
  CONSTRAINT variants_unit_fk FOREIGN KEY (tenant_id, unit_id) REFERENCES catalog.units (tenant_id, id)
);
CREATE INDEX variants_tenant_product_idx ON catalog.variants (tenant_id, product_id, id);
CREATE INDEX variants_tenant_unit_idx ON catalog.variants (tenant_id, unit_id) WHERE unit_id IS NOT NULL;

CREATE TABLE catalog.barcodes (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[\x21-\x7e]{1,64}$'),
  format text NOT NULL CHECK (format IN ('ean13', 'ean8', 'upca', 'upce', 'code128', 'code39', 'qr', 'datamatrix', 'gs1_128', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT barcodes_pkey PRIMARY KEY (tenant_id, id),
  -- Business rule (data-model.md index rule 7): one code, one variant, per tenant. Also the lookup index.
  CONSTRAINT barcodes_code_key UNIQUE (tenant_id, code),
  CONSTRAINT barcodes_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES catalog.variants (tenant_id, id)
);
CREATE INDEX barcodes_tenant_variant_idx ON catalog.barcodes (tenant_id, variant_id, id);

CREATE TABLE catalog.product_media (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  product_id uuid NOT NULL,
  variant_id uuid,
  asset_key text NOT NULL CHECK (length(asset_key) BETWEEN 1 AND 512),
  position smallint NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 99),
  alt text CHECK (length(alt) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_media_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT product_media_product_fk FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products (tenant_id, id),
  CONSTRAINT product_media_variant_fk FOREIGN KEY (tenant_id, variant_id) REFERENCES catalog.variants (tenant_id, id)
);
CREATE INDEX product_media_tenant_product_idx ON catalog.product_media (tenant_id, product_id, position, id);
CREATE INDEX product_media_tenant_variant_idx ON catalog.product_media (tenant_id, variant_id) WHERE variant_id IS NOT NULL;

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "catalog"."units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."units" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."units" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "catalog"."unit_conversions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."unit_conversions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."unit_conversions" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "catalog"."categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."categories" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "catalog"."tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."tags" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "catalog"."products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."products" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."products" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "catalog"."product_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."product_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."product_tags" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "catalog"."variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."variants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."variants" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "catalog"."barcodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."barcodes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."barcodes" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "catalog"."product_media" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."product_media" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."product_media" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege: master data is updated in place (versioned) and never hard-deleted; only owned link rows are deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA catalog FROM wb_app;
GRANT UPDATE (name, parent_id, path, updated_at) ON catalog.categories TO wb_app;
GRANT UPDATE (name, description, category_id, version, archived_at, updated_at, updated_by) ON catalog.products TO wb_app;
GRANT UPDATE (sku, name, unit_id, tracks_batches, tax_category, attributes, version, archived_at, updated_at, updated_by)
  ON catalog.variants TO wb_app;
GRANT DELETE ON catalog.product_tags TO wb_app;
GRANT DELETE ON catalog.barcodes TO wb_app;
GRANT DELETE ON catalog.product_media TO wb_app;
