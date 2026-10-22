-- tenancy: member invites (P0-08b). See docs/architecture/security.md and docs/modules.md (tenancy).
--
-- Same pattern as 0001: PK (tenant_id, id), composite FK to the tenant, tenant-leading indexes, RLS = exact rlsSql()
-- output, least-privilege grants.
--
-- NO TOKEN COLUMN: invite tokens are HMAC-derived from (tenant_id, id) with a server secret and are never stored.
-- Accepting an invite recomputes and constant-time-compares the token, so a database dump cannot mint invites.
--
-- role_ids / branch_ids are uuid[] (array elements cannot carry a FK): the API validates them against
-- tenancy.roles and tenancy.branches when writing (same convention as memberships.branch_ids).
-- invited_by / accepted_by reference identity.users logically, not by FK (global schema, different role).
--
-- "Pending" = neither accepted nor revoked. Expired invites stay pending until revoked; the API must revoke an expired
-- invite before re-inviting that email (expiry cannot appear in a partial index predicate: now() is not immutable).
CREATE TABLE tenancy.invites (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  role_ids uuid[] NOT NULL CHECK (cardinality(role_ids) BETWEEN 1 AND 20 AND array_position(role_ids, NULL) IS NULL),
  branch_ids uuid[] NULL
    CHECK (branch_ids IS NULL OR (cardinality(branch_ids) > 0 AND array_position(branch_ids, NULL) IS NULL)),
  invited_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz NULL,
  accepted_by uuid NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invites_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT invites_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenancy.tenants (tenant_id) ON DELETE RESTRICT,
  CONSTRAINT invites_not_accepted_and_revoked CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL)),
  CONSTRAINT invites_accepted_pair CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);

-- Business rule: at most one pending invite per email per tenant. Re-invite is possible after revoke or accept.
CREATE UNIQUE INDEX invites_tenant_email_pending_key ON tenancy.invites (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Listing pending invites (keyset on created_at, id). The predicate matches listPendingInvites literally, so accepted
-- and revoked rows never enter the index walk. The FK to tenants is covered by the PK.
CREATE INDEX invites_tenant_pending_created_idx ON tenancy.invites (tenant_id, created_at DESC, id DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Accepted and revoked are terminal. wb_app may UPDATE the stamp columns (grant below), so the database, not only the
-- use case's WHERE clause, refuses to reopen, re-stamp or revoke a settled invite.
CREATE FUNCTION tenancy.invites_terminal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'invite % is already settled', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invites_terminal_guard BEFORE UPDATE ON tenancy.invites
  FOR EACH ROW EXECUTE FUNCTION tenancy.invites_terminal_guard();

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "tenancy"."invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy"."invites" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenancy"."invites" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege. Default privileges gave wb_app full DML on this new table: strip it, then grant exactly what the
-- use cases need. email, role_ids, branch_ids, invited_by and expires_at are immutable once inserted.
REVOKE UPDATE, DELETE, TRUNCATE ON tenancy.invites FROM wb_app;
GRANT SELECT, INSERT ON tenancy.invites TO wb_app;
GRANT UPDATE (accepted_at, accepted_by, revoked_at) ON tenancy.invites TO wb_app;
