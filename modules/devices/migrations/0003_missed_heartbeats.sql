-- Missed-heartbeat alerts (ADR 0013 job pattern): the worker finds silent terminals across businesses, then writes one
-- marker per business in a tenant transaction. A terminal is alerted once per silence: it is due again only after it
-- has been seen since the last alert.
ALTER TABLE devices.devices ADD COLUMN offline_alerted_at timestamptz NULL;

GRANT USAGE ON SCHEMA devices TO wb_worker;
-- Find work across tenants: SELECT only, wb_worker only (writes stay tenant-scoped).
GRANT SELECT ON devices.devices TO wb_worker;
GRANT UPDATE (offline_alerted_at) ON devices.devices TO wb_worker;
CREATE POLICY worker_jobs_read ON devices.devices FOR SELECT TO wb_worker USING (true);
-- The tenant-scoped update needs the existing tenant_isolation policy, which already covers wb_worker.
CREATE INDEX devices_silent_idx ON devices.devices (last_seen_at) WHERE status = 'active';
