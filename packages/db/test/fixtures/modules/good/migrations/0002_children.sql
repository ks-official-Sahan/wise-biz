CREATE TABLE good.children (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL
);
CREATE INDEX children_tenant_item_idx ON good.children (tenant_id, item_id);
GRANT SELECT, INSERT ON good.children TO wb_app;
ALTER TABLE "good"."children" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "good"."children" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "good"."children" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
