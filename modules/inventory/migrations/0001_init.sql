-- inventory: the stock ledger (append-only, monthly partitions), balances as a same-transaction projection, batches
-- (lots with cost, expiry and an optional own sale price), reservations, receipts, adjustments, thresholds, and a
-- variant-facts projection of catalog.variant.upserted (inventory never reads catalog tables).
--
-- Decisions:
--   * Quantities are numeric(18,4) in the variant's base unit (+ in, - out). Money is bigint minor units.
--   * stock_balances is keyed (tenant, location, variant, batch) with the nil UUID for "no batch", so it can have a
--     primary key and a plain ON CONFLICT target. The API shows the nil batch as null.
--   * Movements and their balance deltas are written by ONE statement per batch (insert ... on conflict do nothing
--     returning -> grouped balance upsert ordered by key). Rows lock in key order in every transaction: no deadlocks.
--   * Idempotency: unique (tenant, source_type, source_id, source_line, occurred_at). Replaying a document is a no-op
--     (the partition key must be part of every unique index on a partitioned table).
--   * No DEFAULT partition (same reasoning as audit_log): a missing month fails loudly. ensure_partitions keeps
--     months_back..months_ahead in place; offline documents older than months_back need an operator.
--   * Negative balances are allowed (offline oversell) and surface as inventory.balance.negative.
--   * locations live in tenancy; the composition root checks them (no cross-module FK).
CREATE SCHEMA inventory AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA inventory TO wb_app, wb_worker;

-- Projection (consumer inventory.variant-facts).
CREATE TABLE inventory.variant_facts (
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  tracks_batches boolean NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  source_time timestamptz NOT NULL,
  CONSTRAINT variant_facts_pkey PRIMARY KEY (tenant_id, variant_id)
);

CREATE TABLE inventory.batches (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  lot_code text CHECK (length(lot_code) BETWEEN 1 AND 64),
  expires_on date,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  sale_price_minor bigint CHECK (sale_price_minor >= 0),
  receipt_id uuid,
  supplier_id uuid,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batches_pkey PRIMARY KEY (tenant_id, id)
);
CREATE INDEX batches_tenant_variant_expiry_idx ON inventory.batches (tenant_id, variant_id, expires_on, id);
-- The daily expiring job scans by date across variants.
CREATE INDEX batches_tenant_expiry_idx ON inventory.batches (tenant_id, expires_on) WHERE expires_on IS NOT NULL;
CREATE INDEX batches_tenant_receipt_idx ON inventory.batches (tenant_id, receipt_id) WHERE receipt_id IS NOT NULL;

CREATE TABLE inventory.stock_movements (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  batch_id uuid,
  qty numeric(18,4) NOT NULL CHECK (qty <> 0),
  reason text NOT NULL CHECK (reason IN ('sale', 'return', 'receive', 'adjust', 'transfer_in', 'transfer_out',
    'count_variance', 'writeoff', 'expiry')),
  source_type text NOT NULL CHECK (source_type ~ '^[a-z_]{1,32}$'),
  source_id uuid NOT NULL,
  source_line int NOT NULL CHECK (source_line >= 0),
  unit_cost_minor bigint CHECK (unit_cost_minor >= 0),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_movements_pkey PRIMARY KEY (tenant_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);
CREATE UNIQUE INDEX stock_movements_source_key
  ON inventory.stock_movements (tenant_id, source_type, source_id, source_line, occurred_at);
-- History of one SKU, newest first (any location; a location filter rides on it).
CREATE INDEX stock_movements_tenant_variant_idx
  ON inventory.stock_movements (tenant_id, variant_id, occurred_at DESC, id DESC);
-- Latest received cost of a SKU at a location (adjustment valuation): skips the sales in between.
CREATE INDEX stock_movements_tenant_receive_idx
  ON inventory.stock_movements (tenant_id, variant_id, location_id, occurred_at DESC, id DESC) WHERE reason = 'receive';

CREATE TABLE inventory.stock_balances (
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  batch_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  qty numeric(18,4) NOT NULL DEFAULT 0,
  reserved numeric(18,4) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_balances_pkey PRIMARY KEY (tenant_id, location_id, variant_id, batch_id)
);
-- "Where is this SKU?" across locations.
CREATE INDEX stock_balances_tenant_variant_idx ON inventory.stock_balances (tenant_id, variant_id, location_id);

CREATE TABLE inventory.reservations (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  batch_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'committed', 'released')),
  source_type text NOT NULL CHECK (source_type ~ '^[a-z_]{1,32}$'),
  source_id uuid NOT NULL,
  source_line int NOT NULL CHECK (source_line >= 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservations_pkey PRIMARY KEY (tenant_id, id),
  -- Reserving the same document line twice is a no-op.
  CONSTRAINT reservations_source_key UNIQUE (tenant_id, source_type, source_id, source_line, batch_id)
);
CREATE INDEX reservations_tenant_open_idx ON inventory.reservations (tenant_id, expires_at) WHERE status = 'open';

CREATE TABLE inventory.receipts (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  supplier_id uuid,
  purchase_order_id uuid,
  reference text CHECK (length(reference) <= 64),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  received_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipts_pkey PRIMARY KEY (tenant_id, id)
);
CREATE INDEX receipts_tenant_location_idx ON inventory.receipts (tenant_id, location_id, received_at DESC);

CREATE TABLE inventory.receipt_lines (
  tenant_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  line int NOT NULL CHECK (line >= 0),
  variant_id uuid NOT NULL,
  batch_id uuid,
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  CONSTRAINT receipt_lines_pkey PRIMARY KEY (tenant_id, receipt_id, line),
  CONSTRAINT receipt_lines_receipt_fk FOREIGN KEY (tenant_id, receipt_id) REFERENCES inventory.receipts (tenant_id, id),
  CONSTRAINT receipt_lines_batch_fk FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory.batches (tenant_id, id)
);
CREATE INDEX receipt_lines_tenant_batch_idx ON inventory.receipt_lines (tenant_id, batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE inventory.adjustments (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('damage', 'theft', 'loss', 'found', 'count_correction', 'expiry', 'writeoff',
    'sample', 'other')),
  note text CHECK (length(note) <= 500),
  value_minor bigint NOT NULL CHECK (value_minor >= 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT adjustments_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT adjustments_note_for_other CHECK (reason <> 'other' OR note IS NOT NULL)
);
CREATE INDEX adjustments_tenant_location_idx ON inventory.adjustments (tenant_id, location_id, created_at DESC);

CREATE TABLE inventory.adjustment_lines (
  tenant_id uuid NOT NULL,
  adjustment_id uuid NOT NULL,
  line int NOT NULL CHECK (line >= 0),
  variant_id uuid NOT NULL,
  batch_id uuid,
  qty numeric(18,4) NOT NULL CHECK (qty <> 0),
  unit_cost_minor bigint NOT NULL CHECK (unit_cost_minor >= 0),
  CONSTRAINT adjustment_lines_pkey PRIMARY KEY (tenant_id, adjustment_id, line),
  CONSTRAINT adjustment_lines_adjustment_fk FOREIGN KEY (tenant_id, adjustment_id)
    REFERENCES inventory.adjustments (tenant_id, id),
  CONSTRAINT adjustment_lines_batch_fk FOREIGN KEY (tenant_id, batch_id) REFERENCES inventory.batches (tenant_id, id)
);
CREATE INDEX adjustment_lines_tenant_batch_idx ON inventory.adjustment_lines (tenant_id, batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE inventory.stock_thresholds (
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  min_qty numeric(18,4) NOT NULL CHECK (min_qty >= 0),
  max_qty numeric(18,4) CHECK (max_qty IS NULL OR max_qty >= min_qty),
  -- Debounce state for the low-stock evaluator: set when an alert fires, cleared when stock recovers.
  low_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_thresholds_pkey PRIMARY KEY (tenant_id, location_id, variant_id)
);
CREATE INDEX stock_thresholds_tenant_variant_idx ON inventory.stock_thresholds (tenant_id, variant_id);

-- RLS: exact output of rlsSql() from @wise-biz/db (partitions get their own in ensure_partitions).
ALTER TABLE "inventory"."variant_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."variant_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."variant_facts" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."batches" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."stock_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."stock_movements" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."stock_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_balances" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."stock_balances" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."reservations" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."receipts" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."receipt_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."receipt_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."receipt_lines" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."adjustments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."adjustments" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."adjustment_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."adjustment_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."adjustment_lines" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."stock_thresholds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_thresholds" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."stock_thresholds" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege. The ledger is insert-only for everyone; balances move only through the port's upsert.
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA inventory FROM wb_app;
GRANT UPDATE (qty, reserved, version, updated_at) ON inventory.stock_balances TO wb_app;
GRANT UPDATE (status, updated_at) ON inventory.reservations TO wb_app;
GRANT UPDATE (sale_price_minor) ON inventory.batches TO wb_app;
GRANT UPDATE (min_qty, max_qty, low_since, updated_at) ON inventory.stock_thresholds TO wb_app;
GRANT DELETE ON inventory.stock_thresholds TO wb_app;
REVOKE ALL ON inventory.variant_facts FROM wb_app, wb_worker;
GRANT SELECT ON inventory.variant_facts TO wb_app;
GRANT SELECT, INSERT, UPDATE ON inventory.variant_facts TO wb_worker;
-- Jobs (workers): read the ledger, balances, batches and thresholds; flip the low-stock debounce flag.
GRANT SELECT ON inventory.stock_movements, inventory.stock_balances, inventory.batches, inventory.stock_thresholds
  TO wb_worker;
GRANT UPDATE (low_since) ON inventory.stock_thresholds TO wb_worker;

-- Partition maintenance (pattern from audit.ensure_partitions). SECURITY DEFINER (owner wb_migrator) so the worker
-- can keep months ahead without owning the table. Idempotent; returns how many partitions it created. Months are UTC.
CREATE FUNCTION inventory.ensure_partitions(months_back int, months_ahead int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  i int;
  lo timestamptz;
  hi timestamptz;
  part text;
  created int := 0;
  tenant_expr constant text := 'tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid';
BEGIN
  IF months_back IS NULL OR months_back < 0 OR months_back > 36 OR months_ahead IS NULL OR months_ahead < 0
      OR months_ahead > 24 THEN
    RAISE EXCEPTION 'ensure_partitions: months_back 0..36, months_ahead 0..24';
  END IF;
  SET LOCAL lock_timeout = '5s';
  PERFORM pg_advisory_xact_lock(hashtextextended('inventory.ensure_partitions', 0));
  FOR i IN -months_back..months_ahead LOOP
    lo := (date_trunc('month', timezone('UTC', now())) + make_interval(months => i)) AT TIME ZONE 'UTC';
    hi := (date_trunc('month', timezone('UTC', now())) + make_interval(months => i + 1)) AT TIME ZONE 'UTC';
    part := 'stock_movements_' || to_char(timezone('UTC', lo), '"y"YYYY"m"MM');
    IF to_regclass(format('inventory.%I', part)) IS NULL THEN
      EXECUTE format('CREATE TABLE inventory.%I (LIKE inventory.stock_movements INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', part);
      EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format('ALTER TABLE inventory.%I FORCE ROW LEVEL SECURITY', part);
      EXECUTE format('CREATE POLICY tenant_isolation ON inventory.%I USING (%s) WITH CHECK (%s)', part, tenant_expr, tenant_expr);
      EXECUTE format('REVOKE ALL ON inventory.%I FROM PUBLIC, wb_app, wb_worker', part);
      EXECUTE format('ALTER TABLE inventory.stock_movements ATTACH PARTITION inventory.%I FOR VALUES FROM (%L) TO (%L)',
        part, to_char(timezone('UTC', lo), 'YYYY-MM-DD HH24:MI:SS') || '+00', to_char(timezone('UTC', hi), 'YYYY-MM-DD HH24:MI:SS') || '+00');
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;
REVOKE ALL ON FUNCTION inventory.ensure_partitions(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION inventory.ensure_partitions(int, int) TO wb_worker;

SELECT inventory.ensure_partitions(12, 3);
