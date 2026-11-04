-- audit 0002: read side for the console audit viewer (P0-10).
--
-- wb_app gets SELECT on the partitioned parent only. Access through the parent checks the parent's privileges and
-- applies the parent's RLS policy (tenant_isolation), so no per-partition grant is needed and audit.ensure_partitions
-- stays unchanged. Partitions themselves stay unreadable to wb_app when addressed directly.
-- The API gates reads behind audit:read / audit:export; before/after may hold business data, never secrets (rule 10).
--
-- Indexes for the viewer's filters. Keyset order is (at desc, id desc); the PK (tenant_id, at, id) already serves the
-- unfiltered list and date ranges, audit_log_entity_idx serves entity filters. Partitioned parents cannot build
-- indexes CONCURRENTLY; this runs before the table holds production volume.
GRANT SELECT ON audit.audit_log TO wb_app;

CREATE INDEX audit_log_actor_idx ON audit.audit_log (tenant_id, actor_id, at, id);
CREATE INDEX audit_log_action_idx ON audit.audit_log (tenant_id, action, at, id);
