-- A void that arrives before its sale is remembered here and applied when the sale lands (review 2026-11-08).
--
-- The rollup consumer used to throw ("sale not projected yet") and rely on the bus retrying for about 13 seconds; after
-- that the void was dead-lettered and the rollups stayed wrong until someone ran a rebuild. Events of one sale can
-- arrive out of order (several relay replicas, a slow consumer), so waiting is not enough: the void is parked here, in
-- the same transaction that handles the void event, and `onSaleCompleted` applies and clears it in its own transaction.
CREATE TABLE reporting.pending_voids (
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pending_voids_pkey PRIMARY KEY (tenant_id, sale_id)
);
ALTER TABLE reporting.pending_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.pending_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.pending_voids
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Only the rollup consumer (wb_worker) reads and writes it; wb_app has no privilege at all.
REVOKE ALL ON reporting.pending_voids FROM PUBLIC, wb_app;
GRANT SELECT, INSERT, DELETE ON reporting.pending_voids TO wb_worker;
