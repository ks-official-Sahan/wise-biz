-- _template: copy source for new modules. Schema, tables, indexes and RLS in one migration.
CREATE SCHEMA template AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA template TO wb_app;

CREATE TABLE template.items (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Target of the composite FK below; also the keyset index (tenant_id leads).
  CONSTRAINT items_tenant_id_id_key UNIQUE (tenant_id, id)
);

CREATE TABLE template.item_children (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Composite FK: a child can never reference another tenant's item (FK checks bypass RLS, so this is the guard).
  CONSTRAINT item_children_item_fk FOREIGN KEY (tenant_id, item_id)
    REFERENCES template.items (tenant_id, id) ON DELETE CASCADE
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
