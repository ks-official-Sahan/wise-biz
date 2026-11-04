-- theming: the store's look. Versioned themes (one draft, one published, the rest history) and receipt templates.
CREATE SCHEMA theming AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA theming TO wb_app;

-- One row per theme version. A draft has no version yet; publishing assigns the next number. Rows are never deleted:
-- an archived row is the version history and the source of a rollback.
CREATE TABLE theming.themes (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  version integer CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 60),
  input jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT themes_pkey PRIMARY KEY (tenant_id, id),
  -- A draft has no version; every other row has one and a publish time.
  CONSTRAINT themes_state_ck CHECK (
    (status = 'draft' AND version IS NULL AND published_at IS NULL)
    OR (status <> 'draft' AND version IS NOT NULL AND published_at IS NOT NULL)
  )
);
-- At most one draft and one published theme per business; a version number is used once.
CREATE UNIQUE INDEX themes_one_draft_idx ON theming.themes (tenant_id) WHERE status = 'draft';
CREATE UNIQUE INDEX themes_one_published_idx ON theming.themes (tenant_id) WHERE status = 'published';
CREATE UNIQUE INDEX themes_version_idx ON theming.themes (tenant_id, version) WHERE version IS NOT NULL;

-- The receipt layout: one per business, plus an optional override per branch (branch_id is a tenancy id, not an FK:
-- modules never join across schemas).
CREATE TABLE theming.receipt_templates (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  branch_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  paper text NOT NULL CHECK (paper IN ('58', '80')),
  invoice_prefix text NOT NULL DEFAULT '' CHECK (invoice_prefix ~ '^[A-Z0-9-]{0,8}$'),
  footer_text text NOT NULL DEFAULT '' CHECK (length(footer_text) <= 200),
  blocks jsonb NOT NULL,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_templates_pkey PRIMARY KEY (tenant_id, id)
);
-- One template per scope: the business default (branch_id null) and one per branch.
CREATE UNIQUE INDEX receipt_templates_scope_idx
  ON theming.receipt_templates (tenant_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE "theming"."themes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "theming"."themes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "theming"."themes" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "theming"."receipt_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "theming"."receipt_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "theming"."receipt_templates" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege: no deletes anywhere; only the columns that change are updatable.
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA theming FROM wb_app;
GRANT UPDATE (status, version, name, input, published_at) ON theming.themes TO wb_app;
GRANT UPDATE (version, paper, invoice_prefix, footer_text, blocks, updated_by, updated_at) ON theming.receipt_templates TO wb_app;
