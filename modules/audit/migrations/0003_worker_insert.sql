-- audit 0003: the import job (wb_worker, ADR 0012) records its own outcome in the audit log.
--
-- Insert only, through the partitioned parent: that checks the parent's privileges and its tenant_isolation policy
-- (WITH CHECK app.tenant_id), so no partition grant is needed. The chainer fills chain_seq/prev_hash/hash later, as for
-- wb_app rows. wb_worker gets no SELECT/UPDATE/DELETE on the log.
GRANT USAGE ON SCHEMA audit TO wb_worker;
GRANT INSERT (tenant_id, public_id, actor_type, actor_id, action, entity, entity_id, before, after, reason, ip, device_id, request_id) ON audit.audit_log TO wb_worker;
