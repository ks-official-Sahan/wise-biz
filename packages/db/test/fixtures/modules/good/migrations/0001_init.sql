CREATE SCHEMA good AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA good TO wb_app;
CREATE TABLE good.items (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL
);
CREATE INDEX items_tenant_name_idx ON good.items (tenant_id, name);
GRANT SELECT, INSERT, UPDATE, DELETE ON good.items TO wb_app;
ALTER TABLE "good"."items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "good"."items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "good"."items" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
