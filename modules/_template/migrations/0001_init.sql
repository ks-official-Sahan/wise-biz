-- _template: copy source for new modules. Schema, tables, indexes, RLS and grants in one migration.
--
-- PATTERN (every module copies this):
--   * Primary key is (tenant_id, id) on every table. id is UUIDv7, so the PK index is the tenant-leading keyset
--     index and the FK target; no separate PK(id) and no UNIQUE(tenant_id, id) (one index, not two).
--   * Children reference parents with a composite FK (tenant_id, parent_id) -> parent (tenant_id, id): a child can
--     never point at another tenant's parent (FK checks bypass RLS, so this is the guard).
--   * FKs are ON DELETE RESTRICT (the default). CASCADE only for rows that are owned parts of the parent and have no
--     life of their own, and only with a comment justifying it.
--   * Every FK gets an index with tenant_id first: (tenant_id, parent_id, id).
--   * updated_at / deleted_at are deliberately absent: add them only when a use case needs them (soft delete and
--     mutable rows change the index and RLS story). Ledger-like tables never get them.
--
-- LATER MIGRATIONS (expand/contract; never edit a merged file, add the next number):
--   * New column: ADD COLUMN ... NULL -> backfill in batches -> ADD CONSTRAINT ... CHECK (...) NOT VALID
--     -> VALIDATE CONSTRAINT -> SET NOT NULL (reuses the validated CHECK).
--   * New index on a populated table: CREATE INDEX CONCURRENTLY in its own file whose first line is
--     `-- wb:no-transaction` and which holds exactly one statement.
--   * Drop/rename only after no deployed code reads the old shape (contract step, separate migration).
CREATE SCHEMA template AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA template TO wb_app;

CREATE TABLE template.items (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT items_pkey PRIMARY KEY (tenant_id, id)
);

CREATE TABLE template.item_children (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  label text NOT NULL CHECK (btrim(label) <> '' AND length(label) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_children_pkey PRIMARY KEY (tenant_id, id),
  -- RESTRICT: deleting an item that has children must fail loudly. CASCADE only for owned parts, with justification.
  CONSTRAINT item_children_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES template.items (tenant_id, id) ON DELETE RESTRICT
);

-- FK + batch lookup (`item_id = any($ids)`), tenant_id leads.
CREATE INDEX item_children_tenant_item_idx ON template.item_children (tenant_id, item_id, id);

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "template"."items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "template"."items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "template"."items" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "template"."item_children" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "template"."item_children" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "template"."item_children" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege: the template only SELECTs and INSERTs. Default privileges give wb_app DML on migrator tables, so
-- revoke the rest explicitly. A module that needs updates/deletes grants them per table in its own migration, e.g.
--   GRANT UPDATE (name) ON template.items TO wb_app;   GRANT DELETE ON template.item_children TO wb_app;
-- Append-only tables (ledgers, audit, outbox history) keep these revoked forever.
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA template FROM wb_app;
