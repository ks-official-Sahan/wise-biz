-- Export jobs: a person asks for a large file, the worker builds it from the stored facts and the person is told when
-- it is ready. Requests are rows, so a worker crash loses nothing: a stale `running` job is queued again.
CREATE TABLE reporting.exports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sales_lines')),
  -- from, to (business dates) and branch_ids (null: every branch the requester may see, fixed at request time).
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  requested_by uuid NOT NULL,
  row_count bigint,
  object_key text,
  error text CHECK (error IS NULL OR length(error) <= 300),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  CONSTRAINT exports_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT exports_ready_has_key CHECK (status <> 'ready' OR object_key IS NOT NULL)
);
-- A person's recent exports, newest first.
CREATE INDEX exports_requester_idx ON reporting.exports (tenant_id, requested_by, id DESC);
-- The worker's scan: only unfinished jobs.
CREATE INDEX exports_open_idx ON reporting.exports (created_at) WHERE status IN ('queued', 'running');

ALTER TABLE reporting.exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporting.exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reporting.exports
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Find work across tenants: SELECT only, wb_worker only (writes stay tenant-scoped).
CREATE POLICY worker_jobs_read ON reporting.exports FOR SELECT TO wb_worker USING (true);

GRANT SELECT, INSERT ON reporting.exports TO wb_app;
GRANT SELECT ON reporting.exports TO wb_worker;
GRANT UPDATE (status, row_count, object_key, error, attempts, started_at, finished_at) ON reporting.exports TO wb_worker;
