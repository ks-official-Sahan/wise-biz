-- stock transfers between locations (P2-03b). A transfer moves batch-tracked stock out of its source into a holding
-- location that belongs to that transfer alone (in_transit_location_id, a UUIDv7 with no row anywhere else), so
-- receive can read back exactly the batches this transfer dispatched. Stock is written through the inventory port.
--   * Quantities numeric(18,4), values bigint minor units (the PO rules). Ids are UUIDv7 from the server.
--   * Column-level grants: only the columns a transition changes are updatable; nothing is deleted.
CREATE TABLE procurement.transfer_sequences (
  tenant_id uuid PRIMARY KEY,
  last_no bigint NOT NULL CHECK (last_no >= 1)
);

CREATE TABLE procurement.transfers (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  transfer_no bigint NOT NULL CHECK (transfer_no >= 1),
  from_location_id uuid NOT NULL,
  to_location_id uuid NOT NULL,
  in_transit_location_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('requested', 'dispatched', 'received', 'closed', 'cancelled')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  received_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT transfers_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT transfers_no_uq UNIQUE (tenant_id, transfer_no),
  CONSTRAINT transfers_locations_differ CHECK (from_location_id <> to_location_id)
);
-- Keyset list filtered by status (newest first walks id backwards).
CREATE INDEX transfers_status_idx ON procurement.transfers (tenant_id, status, id);
-- "Transfers out of / into this location" lists.
CREATE INDEX transfers_from_idx ON procurement.transfers (tenant_id, from_location_id, id);
CREATE INDEX transfers_to_idx ON procurement.transfers (tenant_id, to_location_id, id);

-- Quantities are per line; a line dispatched from several batches is several ledger movements, not several rows.
-- value_minor is the dispatched stock valued at each batch's own cost, snapshotted at dispatch.
CREATE TABLE procurement.transfer_lines (
  tenant_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  line integer NOT NULL CHECK (line >= 1),
  variant_id uuid NOT NULL,
  requested_qty numeric(18,4) NOT NULL CHECK (requested_qty > 0),
  dispatched_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (dispatched_qty >= 0),
  received_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  -- Received minus dispatched: negative = short, positive = over (received beyond what left the source).
  variance_qty numeric(18,4) NOT NULL DEFAULT 0,
  value_minor bigint NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
  CONSTRAINT transfer_lines_pkey PRIMARY KEY (tenant_id, transfer_id, line),
  CONSTRAINT transfer_lines_variant_uq UNIQUE (tenant_id, transfer_id, variant_id),
  CONSTRAINT transfer_lines_transfer_fk FOREIGN KEY (tenant_id, transfer_id)
    REFERENCES procurement.transfers (tenant_id, id)
);

ALTER TABLE "procurement"."transfer_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."transfer_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "procurement"."transfer_sequences" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "procurement"."transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "procurement"."transfers" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "procurement"."transfer_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "procurement"."transfer_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "procurement"."transfer_lines" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege on the NEW tables only. Do not revoke schema-wide: that would also drop 0001's column grants.
REVOKE UPDATE, DELETE, TRUNCATE ON procurement.transfer_sequences, procurement.transfers, procurement.transfer_lines
  FROM wb_app;
GRANT UPDATE (last_no) ON procurement.transfer_sequences TO wb_app;
GRANT UPDATE (status, currency, version, updated_at, dispatched_at, received_at, closed_at, cancelled_at)
  ON procurement.transfers TO wb_app;
GRANT UPDATE (dispatched_qty, received_qty, variance_qty, value_minor) ON procurement.transfer_lines TO wb_app;
