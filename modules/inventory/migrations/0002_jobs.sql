-- Scheduled inventory jobs (ADR 0013): expiring batches, nightly drift check, partition upkeep. The low-stock evaluator
-- is event-driven (inventory.movement.recorded) and needs nothing here beyond the 0001 grants.

-- Each batch is announced once when it enters the expiry horizon (reruns of the daily job are no-ops).
ALTER TABLE inventory.batches ADD COLUMN expiry_alerted_on date;
GRANT UPDATE (expiry_alerted_on) ON inventory.batches TO wb_worker;

-- Find work across tenants: SELECT only, wb_worker only (writes stay tenant-scoped).
CREATE POLICY worker_jobs_read ON inventory.batches FOR SELECT TO wb_worker USING (true);
CREATE POLICY worker_jobs_read ON inventory.stock_balances FOR SELECT TO wb_worker USING (true);

-- Drift check: last result per tenant (worker-maintained, so the console can show "stock verified at").
CREATE TABLE inventory.drift_checks (
  tenant_id uuid NOT NULL,
  checked_at timestamptz NOT NULL,
  mismatches int NOT NULL CHECK (mismatches >= 0),
  CONSTRAINT drift_checks_pkey PRIMARY KEY (tenant_id)
);
ALTER TABLE "inventory"."drift_checks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."drift_checks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."drift_checks" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON inventory.drift_checks FROM wb_app, wb_worker;
GRANT SELECT ON inventory.drift_checks TO wb_app;
GRANT SELECT, INSERT, UPDATE ON inventory.drift_checks TO wb_worker;

-- Exception to "tenant_id leads" (ADR 0013): the daily expiry job scans all tenants by date; the partial index holds
-- only batches not announced yet, so it stays small.
CREATE INDEX batches_expiry_due_idx ON inventory.batches (expires_on) WHERE expiry_alerted_on IS NULL AND expires_on IS NOT NULL;
