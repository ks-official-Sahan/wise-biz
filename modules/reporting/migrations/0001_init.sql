-- reporting: rollups maintained by sales events. The worker writes, the API reads. Facts tables hold one row per
-- document so a void or a rebuild can undo or recompute a rollup exactly (events carry no history to subtract from).
CREATE SCHEMA reporting AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA reporting TO wb_app, wb_worker;

-- Which branch and terminal a shift belongs to: a return event names only its shift.
CREATE TABLE reporting.shift_facts (
  tenant_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  business_date date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT shift_facts_pkey PRIMARY KEY (tenant_id, shift_id)
);

-- One row per completed sale. Applying the same event twice inserts nothing (the idempotency of the consumer), and a
-- void flips status once, which is the only moment the reversal is applied.
CREATE TABLE reporting.sale_facts (
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  business_date date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  subtotal_minor bigint NOT NULL,
  discount_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  payable_minor bigint NOT NULL,
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  tenders jsonb NOT NULL CHECK (jsonb_typeof(tenders) = 'array'),
  CONSTRAINT sale_facts_pkey PRIMARY KEY (tenant_id, sale_id)
);
CREATE INDEX sale_facts_date_idx ON reporting.sale_facts (tenant_id, business_date);

CREATE TABLE reporting.return_facts (
  tenant_id uuid NOT NULL,
  return_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  business_date date NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL,
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  tenders jsonb NOT NULL CHECK (jsonb_typeof(tenders) = 'array'),
  CONSTRAINT return_facts_pkey PRIMARY KEY (tenant_id, return_id)
);
CREATE INDEX return_facts_date_idx ON reporting.return_facts (tenant_id, business_date);

-- Sales by day, branch and terminal. Sales are net of voids; voids and returns are counted beside them.
CREATE TABLE reporting.rollup_day (
  tenant_id uuid NOT NULL,
  business_date date NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  currency text NOT NULL,
  sales_count integer NOT NULL DEFAULT 0,
  subtotal_minor bigint NOT NULL DEFAULT 0,
  discount_minor bigint NOT NULL DEFAULT 0,
  fee_minor bigint NOT NULL DEFAULT 0,
  tax_minor bigint NOT NULL DEFAULT 0,
  payable_minor bigint NOT NULL DEFAULT 0,
  voids_count integer NOT NULL DEFAULT 0,
  voids_payable_minor bigint NOT NULL DEFAULT 0,
  returns_count integer NOT NULL DEFAULT 0,
  returns_minor bigint NOT NULL DEFAULT 0,
  CONSTRAINT rollup_day_pkey PRIMARY KEY (tenant_id, business_date, branch_id, terminal_id, currency)
);

-- Products by day and branch.
CREATE TABLE reporting.rollup_sku_day (
  tenant_id uuid NOT NULL,
  business_date date NOT NULL,
  branch_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  sku text NOT NULL,
  currency text NOT NULL,
  qty numeric(20, 4) NOT NULL DEFAULT 0,
  revenue_minor bigint NOT NULL DEFAULT 0,
  discount_minor bigint NOT NULL DEFAULT 0,
  tax_minor bigint NOT NULL DEFAULT 0,
  cost_minor bigint NOT NULL DEFAULT 0,
  returned_qty numeric(20, 4) NOT NULL DEFAULT 0,
  refund_minor bigint NOT NULL DEFAULT 0,
  CONSTRAINT rollup_sku_day_pkey PRIMARY KEY (tenant_id, business_date, branch_id, variant_id, currency)
);
-- Top products over a range: the date leads, so a range is one index scan.
CREATE INDEX rollup_sku_day_variant_idx ON reporting.rollup_sku_day (tenant_id, variant_id, business_date);

-- Payments by tender kind, day and branch.
CREATE TABLE reporting.rollup_tender_day (
  tenant_id uuid NOT NULL,
  business_date date NOT NULL,
  branch_id uuid NOT NULL,
  kind text NOT NULL,
  currency text NOT NULL,
  tx_count integer NOT NULL DEFAULT 0,
  sales_minor bigint NOT NULL DEFAULT 0,
  refunds_minor bigint NOT NULL DEFAULT 0,
  CONSTRAINT rollup_tender_day_pkey PRIMARY KEY (tenant_id, business_date, branch_id, kind, currency)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_facts', 'sale_facts', 'return_facts', 'rollup_day', 'rollup_sku_day', 'rollup_tender_day']
  LOOP
    EXECUTE format('ALTER TABLE reporting.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE reporting.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON reporting.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- The API only reads rollups. The worker owns every write (the consumer and the rebuild).
REVOKE ALL ON ALL TABLES IN SCHEMA reporting FROM wb_app, wb_worker;
GRANT SELECT ON reporting.rollup_day, reporting.rollup_sku_day, reporting.rollup_tender_day TO wb_app;
GRANT SELECT, INSERT ON reporting.shift_facts, reporting.return_facts TO wb_worker;
GRANT SELECT, INSERT, UPDATE (status) ON reporting.sale_facts TO wb_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON reporting.rollup_day, reporting.rollup_sku_day, reporting.rollup_tender_day TO wb_worker;
-- A rebuild is requested through the API and run with the app's own tenant transaction: it needs the facts and the
-- right to replace a range of rollups.
GRANT SELECT ON reporting.sale_facts, reporting.return_facts TO wb_app;
GRANT INSERT, UPDATE, DELETE ON reporting.rollup_day, reporting.rollup_sku_day, reporting.rollup_tender_day TO wb_app;
