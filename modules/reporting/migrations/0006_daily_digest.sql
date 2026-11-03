-- Daily summary: one marker per (business, business date) so the digest is raised once, however many workers run.
CREATE TABLE reporting.digests (
  tenant_id uuid NOT NULL,
  business_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digests_pkey PRIMARY KEY (tenant_id, business_date)
);
ALTER TABLE reporting.digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.digests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.digests
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON reporting.digests TO wb_worker;

-- Find businesses that sold on a date: SELECT only, wb_worker only (every write stays tenant-scoped).
CREATE POLICY worker_jobs_read ON reporting.rollup_day FOR SELECT TO wb_worker USING (true);
CREATE POLICY worker_jobs_read ON reporting.digests FOR SELECT TO wb_worker USING (true);
