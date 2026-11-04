-- Staff report: sales per operator (the person signed in at the terminal) per day. Same rules as the other rollups:
-- the worker writes from events and rebuilds from facts, the API reads.
ALTER TABLE reporting.sale_facts ADD COLUMN operator_id uuid NULL;

-- Rows from before this migration have no operator: they are grouped under the nil UUID ("unknown").
CREATE TABLE reporting.rollup_operator_day (
  tenant_id uuid NOT NULL,
  business_date date NOT NULL,
  branch_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  currency text NOT NULL,
  sales_count integer NOT NULL DEFAULT 0,
  discount_minor bigint NOT NULL DEFAULT 0,
  payable_minor bigint NOT NULL DEFAULT 0,
  voids_count integer NOT NULL DEFAULT 0,
  voids_payable_minor bigint NOT NULL DEFAULT 0,
  CONSTRAINT rollup_operator_day_pkey PRIMARY KEY (tenant_id, business_date, branch_id, operator_id, currency)
);

ALTER TABLE reporting.rollup_operator_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.rollup_operator_day FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.rollup_operator_day
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT ON reporting.rollup_operator_day TO wb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.rollup_operator_day TO wb_worker;
-- A rebuild runs in the app's own tenant transaction (see 0001).
GRANT INSERT, UPDATE, DELETE ON reporting.rollup_operator_day TO wb_app;
GRANT UPDATE (operator_id) ON reporting.sale_facts TO wb_worker;
