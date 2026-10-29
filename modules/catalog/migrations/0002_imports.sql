-- Bulk import (P1-02c, ADR 0012). The API creates the row (and its audit + outbox event); the workers' job parses the
-- file in batches, each batch its own transaction, and records progress here so a retry resumes.
CREATE TABLE catalog.imports (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  file_name text NOT NULL CHECK (btrim(file_name) <> '' AND length(file_name) <= 200),
  content_type text NOT NULL CHECK (content_type IN ('text/csv')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 20971520),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  source_key text NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_upload'
    CHECK (status IN ('awaiting_upload', 'queued', 'running', 'done', 'failed')),
  total_rows integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  ok_rows integer NOT NULL DEFAULT 0 CHECK (ok_rows >= 0),
  error_rows integer NOT NULL DEFAULT 0 CHECK (error_rows >= 0),
  -- Data rows already committed (the job resumes after them).
  next_row integer NOT NULL DEFAULT 0 CHECK (next_row >= 0),
  -- Row errors found so far: [{row, column, error}], capped (the full report is the CSV object).
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),
  report_key text,
  failure text CHECK (length(failure) <= 500),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT imports_pkey PRIMARY KEY (tenant_id, id),
  -- Idempotent by file hash: the same file again returns the existing import.
  CONSTRAINT imports_sha256_key UNIQUE (tenant_id, sha256)
);

-- Import groups new SKUs under an existing active product of the same name (case-insensitive).
CREATE INDEX products_tenant_lower_name_idx ON catalog.products (tenant_id, lower(name)) WHERE archived_at IS NULL;

ALTER TABLE "catalog"."imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog"."imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "catalog"."imports" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON catalog.imports FROM wb_app;
GRANT UPDATE (status, started_at) ON catalog.imports TO wb_app;

-- wb_worker (ADR 0012): the import job reads references and writes products, variants, barcodes and tags, always inside
-- a transaction scoped to the import's tenant (tenant_isolation applies to every role).
GRANT USAGE ON SCHEMA catalog TO wb_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO wb_worker;
GRANT INSERT ON catalog.products, catalog.variants, catalog.barcodes, catalog.product_tags TO wb_worker;
GRANT UPDATE (name, updated_at, updated_by, version) ON catalog.products TO wb_worker;
GRANT UPDATE (name, unit_id, tracks_batches, tax_category, version, updated_at, updated_by) ON catalog.variants TO wb_worker;
GRANT UPDATE (status, total_rows, ok_rows, error_rows, next_row, errors, report_key, failure, started_at, finished_at)
  ON catalog.imports TO wb_worker;
