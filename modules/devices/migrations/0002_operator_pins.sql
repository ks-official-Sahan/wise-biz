-- Operator PINs and device-bound operator sessions (P1-01b).
--
-- A PIN unlocks a registered terminal for one operator; it never works anywhere else. Stored twice:
--   * pin_hash: Argon2id (m=19 MiB, t=2) with the server pepper as the Argon2 secret. Verified on every online login.
--   * pin_lookup: HMAC-SHA256(pepper, tenant:pin). Enforces "unique per tenant" without comparing hashes pairwise.
--   * offline_verifier: low-cost Argon2id WITHOUT the pepper (the terminal has no pepper), shipped in the signed policy
--     snapshot so a terminal can unlock offline. Weaker by design; see security.md for the parameters and trade-off.
-- 5 failed logins lock the PIN until a supervisor resets it (audited). Counting is per operator, in this row.
--
-- user_id references identity.users logically (global schema); membership is checked through the composition root.
CREATE TABLE devices.operator_pins (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  pin_hash text NOT NULL CHECK (pin_hash LIKE '$argon2id$%'),
  pin_lookup bytea NOT NULL CHECK (length(pin_lookup) = 32),
  offline_verifier text NOT NULL CHECK (offline_verifier LIKE '$argon2id$%'),
  failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  locked_at timestamptz,
  set_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_pins_pkey PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT operator_pins_lookup_key UNIQUE (tenant_id, pin_lookup),
  CONSTRAINT operator_pins_locked CHECK ((failed_attempts = 5) = (locked_at IS NOT NULL))
);

-- An operator session lives on one terminal: every request is still signed by that device, and the session id rides
-- in `x-wb-operator-session`. Ended by logout, by a newer login on the same terminal, or by expiry (12 h).
CREATE TABLE devices.operator_sessions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  CONSTRAINT operator_sessions_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT operator_sessions_device_fk FOREIGN KEY (tenant_id, device_id)
    REFERENCES devices.devices (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT operator_sessions_window CHECK (expires_at > started_at)
);
-- FK + "end the open session on this terminal" lookup.
CREATE INDEX operator_sessions_device_open_idx ON devices.operator_sessions (tenant_id, device_id)
  WHERE ended_at IS NULL;

ALTER TABLE "devices"."operator_pins" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "devices"."operator_pins" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "devices"."operator_pins" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "devices"."operator_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "devices"."operator_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "devices"."operator_sessions" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

REVOKE UPDATE, DELETE, TRUNCATE ON devices.operator_pins, devices.operator_sessions FROM wb_app;
GRANT UPDATE (pin_hash, pin_lookup, offline_verifier, failed_attempts, locked_at, set_at) ON devices.operator_pins TO wb_app;
GRANT UPDATE (ended_at) ON devices.operator_sessions TO wb_app;
