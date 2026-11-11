-- tenancy 0007: grant the counts:* permissions to existing system roles (commit 6f0b01b).
--
-- New tenants get these grants from DEFAULT_ROLE_GRANTS (modules/tenancy/src/domain/business.ts). This brings tenants
-- created before that change in line: manager gets counts:read/write/approve, inventory_clerk gets counts:read/write,
-- accountant gets counts:read. owner, supervisor and cashier get nothing (same as the defaults). This list is frozen
-- here on purpose; later changes to DEFAULT_ROLE_GRANTS need their own migration.
--
-- Why this differs from 0003 ("no backfill"): the migrator is NOBYPASSRLS and FORCE RLS hides every tenant from it,
-- so it cannot list tenants. The policy below is a transient SELECT-only policy for wb_migrator on tenancy.tenants,
-- exposing tenant ids only. It is dropped in this same transaction, so the committed schema has no cross-tenant
-- read (ADR 0013 covers the permanent worker policies; this one is not a pattern to copy). Writes happen one tenant at
-- a time with app.tenant_id set, so tenant_isolation WITH CHECK still applies. The permissions_version trigger bumps
-- each tenant that gained a grant exactly once (ADR 0010). Memberships are read fresh per request, so none are touched.
--
-- Safety: only is_system roles with the exact names above are matched, so custom roles are never read or written.
-- Re-running adds nothing (ON CONFLICT on role_permissions_role_permission_key) and bumps nothing.
-- Lock: CREATE POLICY takes an ACCESS EXCLUSIVE lock on tenancy.tenants until this transaction commits, so tenant
-- reads wait for the whole backfill. Acceptable for a one-off on a pre-release tenant count; revisit if it grows.

CREATE POLICY backfill_tenant_ids ON tenancy.tenants FOR SELECT TO wb_migrator USING (true);

DO $$
DECLARE
  ids uuid[];
  tid uuid;
BEGIN
  -- Collect the ids first: changing app.tenant_id must not happen under a live cursor.
  SELECT coalesce(array_agg(tenant_id ORDER BY tenant_id), '{}') INTO ids FROM tenancy.tenants;
  FOREACH tid IN ARRAY ids LOOP
    PERFORM set_config('app.tenant_id', tid::text, true);
    -- Index use: roles_pkey (tenant_id, id) for the tenant scan; role_permissions_role_permission_key for ON CONFLICT.
    INSERT INTO tenancy.role_permissions (tenant_id, role_id, permission)
    SELECT r.tenant_id, r.id, g.permission
    FROM tenancy.roles r
    JOIN (VALUES
      ('manager', 'counts:read'),
      ('manager', 'counts:write'),
      ('manager', 'counts:approve'),
      ('inventory_clerk', 'counts:read'),
      ('inventory_clerk', 'counts:write'),
      ('accountant', 'counts:read')
    ) AS g(role_name, permission) ON g.role_name = r.name
    WHERE r.tenant_id = tid AND r.is_system
    ON CONFLICT (tenant_id, role_id, permission) DO NOTHING;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;

DROP POLICY backfill_tenant_ids ON tenancy.tenants;
