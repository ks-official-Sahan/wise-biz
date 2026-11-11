-- stock counts (P2-04a). A count snapshots stock_balances at its location (expected_qty), collects scans (insert-only,
-- tagged with the line's round), and closes with a second snapshot of the same projection (close_qty). The movements
-- that happened while counting are close_qty - expected_qty. Both are single-statement, commit-consistent cuts of
-- balances, so no ledger time window is needed (offline sales that arrive backdated are still counted correctly).
-- Approval writes count_variance movements through recordMovements, in the same transaction as audit and outbox.
--   * Quantities numeric(18,4), values bigint minor units. Ids are UUIDv7 from the server or the device.
--   * batch_id is stored as the nil UUID for "no batch" (the stock_balances convention); the API shows null.

-- Category membership for cycle counts (catalog.variant.upserted carries categoryIds). Rows written before this
-- migration get their categories on the next variant event.
ALTER TABLE inventory.variant_facts ADD COLUMN category_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(category_ids) <= 64);

CREATE TABLE inventory.stock_counts (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  location_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('full', 'cycle')),
  scope_category_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(scope_category_ids) <= 50),
  scope_variant_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(scope_variant_ids) <= 1000),
  blind boolean NOT NULL,
  mode text NOT NULL CHECK (mode IN ('frozen', 'live')),
  status text NOT NULL CHECK (status IN ('draft', 'open', 'review', 'approved', 'cancelled')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL,
  started_at timestamptz,
  closed_by uuid,
  closed_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_counts_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT stock_counts_cycle_scope CHECK (kind = 'full'
    OR cardinality(scope_category_ids) + cardinality(scope_variant_ids) > 0),
  CONSTRAINT stock_counts_approval CHECK ((status = 'approved') = (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT stock_counts_cancellation CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
-- One active count per location (draft, open or review): two counts of one location would apply their variances twice.
-- Known limit: this also refuses parallel cycle counts of disjoint categories at one location.
CREATE UNIQUE INDEX stock_counts_one_active_uq ON inventory.stock_counts (tenant_id, location_id)
  WHERE status IN ('draft', 'open', 'review');
CREATE INDEX stock_counts_status_idx ON inventory.stock_counts (tenant_id, status, id);
CREATE INDEX stock_counts_location_idx ON inventory.stock_counts (tenant_id, location_id, id);

CREATE TABLE inventory.count_lines (
  tenant_id uuid NOT NULL,
  count_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  batch_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  -- On hand at the snapshot cut (0 when the key had no balance row then).
  expected_qty numeric(18,4) NOT NULL DEFAULT 0,
  -- On hand at the close cut, set at close.
  close_qty numeric(18,4),
  -- Sum of this line's scans in its current round, set at close (NULL = not counted).
  counted_qty numeric(18,4) CHECK (counted_qty >= 0),
  -- Bumped by each recount request; scans carry the round they were taken in.
  round integer NOT NULL DEFAULT 1 CHECK (round >= 1),
  recount_requested boolean NOT NULL DEFAULT false,
  -- Valued at close from the batch cost or the latest receipt in the count's currency; NULL when unknown.
  unit_cost_minor bigint CHECK (unit_cost_minor >= 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT count_lines_pkey PRIMARY KEY (tenant_id, count_id, variant_id, batch_id),
  CONSTRAINT count_lines_count_fk FOREIGN KEY (tenant_id, count_id) REFERENCES inventory.stock_counts (tenant_id, id)
);

-- One device scan. Insert-only: the id is the client's UUIDv7, so a replayed scan is a no-op (on conflict do nothing).
CREATE TABLE inventory.count_scans (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  count_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  batch_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  round integer NOT NULL CHECK (round >= 1),
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  device_id uuid,
  scanned_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT count_scans_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT count_scans_line_fk FOREIGN KEY (tenant_id, count_id, variant_id, batch_id)
    REFERENCES inventory.count_lines (tenant_id, count_id, variant_id, batch_id)
);
-- Serves the line foreign key and the close-time sum of the current round.
CREATE INDEX count_scans_line_idx ON inventory.count_scans (tenant_id, count_id, variant_id, batch_id, round);

ALTER TABLE "inventory"."stock_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."stock_counts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."stock_counts" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."count_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."count_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."count_lines" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."count_scans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."count_scans" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."count_scans" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege on the NEW tables only (a schema-wide revoke would drop 0001's column grants). Scans are insert-only;
-- a count's header and lines move through the listed columns only; nothing is deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON inventory.stock_counts, inventory.count_lines, inventory.count_scans FROM wb_app;
GRANT SELECT, INSERT ON inventory.stock_counts, inventory.count_lines, inventory.count_scans TO wb_app;
GRANT UPDATE (status, version, started_at, closed_by, closed_at, approved_by, approved_at, cancelled_at, updated_at)
  ON inventory.stock_counts TO wb_app;
GRANT UPDATE (close_qty, counted_qty, round, recount_requested, unit_cost_minor, note, updated_at)
  ON inventory.count_lines TO wb_app;
