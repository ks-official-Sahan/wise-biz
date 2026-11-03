-- Sales by hour of the branch's local day (the rush-hour view). The hour is worked out once, when the sale arrives, from
-- the branch's time zone, and kept on the fact, so a rebuild never needs the zone and never disagrees with the events.
ALTER TABLE reporting.sale_facts
  ADD COLUMN completed_at timestamptz NULL,
  ADD COLUMN local_hour smallint NULL CHECK (local_hour BETWEEN 0 AND 23);

-- Facts from before this migration have no hour and are left out of the hourly view.
CREATE TABLE reporting.rollup_hour (
  tenant_id uuid NOT NULL,
  business_date date NOT NULL,
  branch_id uuid NOT NULL,
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  currency text NOT NULL,
  sales_count integer NOT NULL DEFAULT 0,
  payable_minor bigint NOT NULL DEFAULT 0,
  CONSTRAINT rollup_hour_pkey PRIMARY KEY (tenant_id, business_date, branch_id, hour, currency)
);
ALTER TABLE reporting.rollup_hour ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.rollup_hour FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.rollup_hour
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON reporting.rollup_hour TO wb_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.rollup_hour TO wb_worker;
-- A rebuild runs in the app's own tenant transaction (see 0001).
GRANT INSERT, UPDATE, DELETE ON reporting.rollup_hour TO wb_app;
