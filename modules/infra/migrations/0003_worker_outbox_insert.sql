-- ADR 0012: module jobs in the workers append their events in the same transaction as their writes.
-- The tenant_isolation policy (WITH CHECK tenant_id = app.tenant_id) governs the insert; no USING (true) policy is added.
GRANT INSERT (tenant_id, id, topic, key, type, version, payload, headers) ON infra.outbox TO wb_worker;
