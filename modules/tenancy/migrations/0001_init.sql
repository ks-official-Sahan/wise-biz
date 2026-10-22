-- tenancy: tenants, branches, locations, roles, role grants, memberships, settings. See docs/adr/0010.
--
-- Same pattern as modules/_template: PK (tenant_id, id), composite FKs so a child can never point at another tenant's
-- parent, tenant-leading index on every FK, RLS = exact rlsSql() output, least-privilege grants.
--
-- Two deliberate departures from the template:
--   * tenancy.tenants is keyed by tenant_id alone (the row IS the tenant).
--   * memberships and tenants have an EXTRA permissive SELECT policy keyed on app.user_id, so a signed-in user can list
--     their own tenants BEFORE one is active (withUserTx sets app.user_id and an empty tenant). Writes stay tenant-only.
--
-- permissions_version: a statement-level trigger on role_permissions ONLY bumps tenants.permissions_version once per
-- tenant per statement. The API caches the policy MATRIX (role -> grants) under `t:{tenant}:perm:v{version}`, and that
-- matrix depends on role_permissions alone. Memberships (status, branch scope) and membership_roles are read fresh on
-- every request by loadMembership, so changing them needs no cache invalidation and no trigger (ADR 0010).
-- The trigger function is SECURITY DEFINER (owner wb_migrator) so wb_app needs NO UPDATE grant on
-- tenants.permissions_version / status: runtime code cannot forge a version or reactivate a tenant. FORCE RLS still
-- applies to the owner; the function runs inside the triggering statement's transaction, so app.tenant_id is set.
--
-- memberships.branch_ids is a uuid[] (NULL = all branches): array elements cannot carry a FK, the API validates them
-- against tenancy.branches when writing. memberships.user_id references identity.users logically, not by FK (global
-- schema, different role; deleting a user is an identity concern and memberships are removed by the tenancy module).
--
-- LATER MIGRATIONS: see _template (expand/contract; CREATE INDEX CONCURRENTLY in its own `-- wb:no-transaction` file).
CREATE SCHEMA tenancy AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA tenancy TO wb_app;

CREATE TABLE tenancy.tenants (
  tenant_id uuid NOT NULL DEFAULT uuidv7(),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  permissions_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_pkey PRIMARY KEY (tenant_id)
);

CREATE TABLE tenancy.branches (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  kind text NOT NULL CHECK (kind IN ('store', 'warehouse', 'office')),
  timezone text NOT NULL CHECK (length(timezone) <= 64),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_region text NOT NULL CHECK (length(tax_region) <= 32),
  business_day_cutoff time NOT NULL DEFAULT '00:00',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT branches_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT branches_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenancy.tenants (tenant_id) ON DELETE RESTRICT
);

CREATE TABLE tenancy.locations (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locations_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT locations_branch_fk FOREIGN KEY (tenant_id, branch_id)
    REFERENCES tenancy.branches (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX locations_tenant_branch_idx ON tenancy.locations (tenant_id, branch_id, id);

CREATE TABLE tenancy.roles (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$' AND name <> 'platform_admin'),
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT roles_tenant_name_key UNIQUE (tenant_id, name),
  CONSTRAINT roles_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenancy.tenants (tenant_id) ON DELETE RESTRICT
);

CREATE TABLE tenancy.role_permissions (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission text NOT NULL CHECK (length(permission) <= 100),
  conditions jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT role_permissions_role_fk FOREIGN KEY (tenant_id, role_id)
    REFERENCES tenancy.roles (tenant_id, id) ON DELETE RESTRICT,
  -- Also the tenant-leading index for the role FK and for "grants of a role" lookups.
  CONSTRAINT role_permissions_role_permission_key UNIQUE (tenant_id, role_id, permission),
  CONSTRAINT role_permissions_conditions_object CHECK (conditions IS NULL OR jsonb_typeof(conditions) = 'object')
);

CREATE TABLE tenancy.memberships (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  branch_ids uuid[] NULL CHECK (branch_ids IS NULL OR cardinality(branch_ids) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT memberships_tenant_user_key UNIQUE (tenant_id, user_id),
  CONSTRAINT memberships_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenancy.tenants (tenant_id) ON DELETE RESTRICT
);
-- "My tenants" (withUserTx, no tenant set): the one index where tenant_id does not lead, because the lookup is by user.
CREATE INDEX memberships_user_tenant_idx ON tenancy.memberships (user_id, tenant_id);

CREATE TABLE tenancy.membership_roles (
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  CONSTRAINT membership_roles_pkey PRIMARY KEY (tenant_id, membership_id, role_id),
  CONSTRAINT membership_roles_membership_fk FOREIGN KEY (tenant_id, membership_id)
    REFERENCES tenancy.memberships (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT membership_roles_role_fk FOREIGN KEY (tenant_id, role_id)
    REFERENCES tenancy.roles (tenant_id, id) ON DELETE RESTRICT
);
-- Role FK + "who holds this role" (the PK leads with membership_id, so it cannot serve the role side).
CREATE INDEX membership_roles_tenant_role_idx ON tenancy.membership_roles (tenant_id, role_id);

CREATE TABLE tenancy.settings (
  tenant_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,99}$'),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_pkey PRIMARY KEY (tenant_id, key),
  CONSTRAINT settings_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenancy.tenants (tenant_id) ON DELETE RESTRICT
);

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "tenancy"."tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy"."tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenancy"."tenants" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "tenancy"."branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy"."branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenancy"."branches" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "tenancy"."locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy"."locations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenancy"."locations" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "tenancy"."roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy"."roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenancy"."roles" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "tenancy"."role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy"."role_permissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenancy"."role_permissions" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "tenancy"."memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy"."memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenancy"."memberships" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "tenancy"."membership_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy"."membership_roles" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenancy"."membership_roles" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "tenancy"."settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenancy"."settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenancy"."settings" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- "My tenants" before a tenant is active: permissive SELECT-only policies keyed on app.user_id (set by withUserTx).
-- They apply ONLY while no tenant is active: once a tenant is set (withTenantTx) the user must see just that tenant's
-- rows, never their other memberships. memberships policies never reference tenants, so there is no recursion.
CREATE POLICY own_memberships ON tenancy.memberships FOR SELECT TO wb_app
  USING (nullif(current_setting('app.tenant_id', true), '') IS NULL
    AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY own_tenants ON tenancy.tenants FOR SELECT TO wb_app
  USING (nullif(current_setting('app.tenant_id', true), '') IS NULL AND tenant_id IN (
    SELECT m.tenant_id FROM tenancy.memberships m
    WHERE m.user_id = nullif(current_setting('app.user_id', true), '')::uuid AND m.status = 'active'));

-- permissions_version bump (see header). SECURITY DEFINER with a pinned search_path; owner is wb_migrator (the role
-- running this migration). Statement-level with a transition table: one UPDATE per tenant per statement.
CREATE FUNCTION tenancy.bump_permissions_version() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = pg_catalog, tenancy AS $$
DECLARE
  expected integer;
  bumped integer;
BEGIN
  SELECT count(DISTINCT tenant_id) INTO expected FROM changed_rows;
  UPDATE tenancy.tenants SET permissions_version = permissions_version + 1
  WHERE tenant_id IN (SELECT DISTINCT tenant_id FROM changed_rows);
  GET DIAGNOSTICS bumped = ROW_COUNT;
  -- FORCE RLS applies to this owner-run function: the bump only sees tenants matching app.tenant_id. A grant change
  -- made outside that tenant's context would otherwise silently skip the bump and leave a stale cached matrix.
  IF bumped <> expected THEN
    RAISE EXCEPTION 'role_permissions changed outside the tenant context (permissions_version not bumped)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $$;
REVOKE EXECUTE ON FUNCTION tenancy.bump_permissions_version() FROM PUBLIC;

CREATE TRIGGER role_permissions_bump_ins AFTER INSERT ON tenancy.role_permissions
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION tenancy.bump_permissions_version();
CREATE TRIGGER role_permissions_bump_upd AFTER UPDATE ON tenancy.role_permissions
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION tenancy.bump_permissions_version();
CREATE TRIGGER role_permissions_bump_del AFTER DELETE ON tenancy.role_permissions
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION tenancy.bump_permissions_version();

-- Least privilege. Default privileges gave wb_app full DML; strip it, then grant exactly what the use cases need.
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA tenancy FROM wb_app;
GRANT UPDATE (name) ON tenancy.tenants TO wb_app;
GRANT UPDATE (name, timezone, currency, tax_region, business_day_cutoff) ON tenancy.branches TO wb_app;
GRANT UPDATE (status, branch_ids) ON tenancy.memberships TO wb_app;
GRANT UPDATE (value, updated_at) ON tenancy.settings TO wb_app;
GRANT DELETE ON tenancy.membership_roles, tenancy.role_permissions TO wb_app;
