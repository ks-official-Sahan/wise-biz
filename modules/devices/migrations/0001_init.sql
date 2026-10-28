-- devices: terminals that may sell (P1-01). Same table pattern as _template: PK (tenant_id, id), RLS on every table.
--
-- Enrollment: an owner creates a one-time code in the console (tenant, branch, name, 15 min). The terminal sends the
-- code with its Ed25519 public key; redeeming the code creates the device directly as `active` (the owner already
-- approved it by creating the code). Only the SHA-256 of a code is stored.
--
-- Before a tenant is known, two SELECT-only policies expose exactly one row, keyed on a transaction-local setting
-- (withLookupTx in @wise-biz/db): `app.enrollment_code` (a code hash) and `app.device_id` (the keyid of a signed
-- request). Knowing a device id reveals only that device's public key and status; the signature check follows.
--
-- branch_id references tenancy.branches logically, not by FK (no cross-module FKs; the API validates it).
-- device_heartbeats is append-only; 90-day retention (monthly partitions or a per-tenant prune) is a P1 follow-up.
CREATE SCHEMA devices AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA devices TO wb_app;

CREATE TABLE devices.devices (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 80),
  platform text NOT NULL CHECK (platform IN ('android', 'ios', 'windows', 'macos', 'linux', 'web')),
  app_version text NOT NULL CHECK (length(app_version) BETWEEN 1 AND 32),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'suspended', 'revoked', 'blacklisted')),
  -- Raw 32-byte Ed25519 public key.
  public_key bytea NOT NULL CHECK (length(public_key) = 32),
  enrolled_by uuid NOT NULL,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  CONSTRAINT devices_pkey PRIMARY KEY (tenant_id, id),
  -- One key per device; a key can never be enrolled twice (in any tenant).
  CONSTRAINT devices_public_key_key UNIQUE (public_key)
);
-- The signed-request lookup is by id alone (tenant unknown): unique so one device id maps to one tenant.
CREATE UNIQUE INDEX devices_id_key ON devices.devices (id);
CREATE INDEX devices_tenant_branch_idx ON devices.devices (tenant_id, branch_id, id);

CREATE TABLE devices.enrollment_codes (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  code_hash bytea NOT NULL CHECK (length(code_hash) = 32),
  branch_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 80),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  device_id uuid,
  CONSTRAINT enrollment_codes_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT enrollment_codes_code_hash_key UNIQUE (code_hash),
  CONSTRAINT enrollment_codes_redeemed_pair CHECK ((redeemed_at IS NULL) = (device_id IS NULL)),
  CONSTRAINT enrollment_codes_device_fk FOREIGN KEY (tenant_id, device_id)
    REFERENCES devices.devices (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX enrollment_codes_tenant_device_idx ON devices.enrollment_codes (tenant_id, device_id)
  WHERE device_id IS NOT NULL;

CREATE TABLE devices.device_heartbeats (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  app_version text NOT NULL CHECK (length(app_version) BETWEEN 1 AND 32),
  battery_pct smallint CHECK (battery_pct BETWEEN 0 AND 100),
  unsynced_count integer NOT NULL DEFAULT 0 CHECK (unsynced_count >= 0),
  oldest_unsynced_at timestamptz,
  operator_id uuid,
  connection text CHECK (connection IN ('wifi', 'ethernet', 'cellular', 'offline', 'unknown')),
  CONSTRAINT device_heartbeats_pkey PRIMARY KEY (tenant_id, device_id, at),
  -- CASCADE never: heartbeats outlive nothing (devices are never deleted, only revoked).
  CONSTRAINT device_heartbeats_device_fk FOREIGN KEY (tenant_id, device_id)
    REFERENCES devices.devices (tenant_id, id) ON DELETE RESTRICT
);
-- Prune by age across tenants (worker job).
CREATE INDEX device_heartbeats_at_idx ON devices.device_heartbeats (at);

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "devices"."devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "devices"."devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "devices"."devices" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "devices"."enrollment_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "devices"."enrollment_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "devices"."enrollment_codes" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "devices"."device_heartbeats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "devices"."device_heartbeats" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "devices"."device_heartbeats" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Single-row lookups before a tenant is known (see header). Only while no tenant is active, SELECT only.
CREATE POLICY lookup_device ON devices.devices FOR SELECT TO wb_app
  USING (nullif(current_setting('app.tenant_id', true), '') IS NULL
    AND id = nullif(current_setting('app.device_id', true), '')::uuid);
CREATE POLICY lookup_enrollment_code ON devices.enrollment_codes FOR SELECT TO wb_app
  USING (nullif(current_setting('app.tenant_id', true), '') IS NULL
    AND code_hash = decode(nullif(current_setting('app.enrollment_code', true), ''), 'hex'));

-- Least privilege. Devices are never deleted (revoked/blacklisted instead); heartbeats are append-only.
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA devices FROM wb_app;
GRANT UPDATE (name, branch_id, status, status_changed_at, last_seen_at, app_version) ON devices.devices TO wb_app;
GRANT UPDATE (redeemed_at, device_id) ON devices.enrollment_codes TO wb_app;
