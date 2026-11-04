-- identity: two-factor (email OTP, backup codes) and passkeys (WebAuthn). GLOBAL schema, see 0001_init.sql.
--
-- Only wb_identity (the identity module's own pool) may touch these tables. wb_app, wb_worker, wb_chainer and PUBLIC
-- get nothing, same as the rest of the schema. findGlobalSchemaLeaks (rls-check) enforces it.
--
-- IDs are UUIDv7: app-generated via @wise-biz/ids; uuidv7() is the backstop default.

-- Read on every sign-in to decide whether to issue a second-factor challenge.
ALTER TABLE identity.users ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false;

-- One row per user. secret and backup_codes hold what Better Auth's twoFactor plugin produces (never log them).
-- CASCADE: an owned part of the user with no life of its own (same reasoning as sessions and accounts).
CREATE TABLE identity.two_factors (
  id uuid NOT NULL DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  secret text NOT NULL,
  backup_codes text NOT NULL,
  -- better-auth 1.7.12 twoFactor plugin state: enrollment verified, failed OTP attempts, lockout.
  verified boolean NOT NULL DEFAULT true,
  failed_verification_count integer NOT NULL DEFAULT 0 CHECK (failed_verification_count >= 0),
  locked_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT two_factors_pkey PRIMARY KEY (id),
  -- One factor per user. The UNIQUE also serves as the FK index.
  CONSTRAINT two_factors_user_key UNIQUE (user_id),
  CONSTRAINT two_factors_user_fk FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE
);

-- CASCADE: a passkey is an owned credential of the user with no life of its own.
CREATE TABLE identity.passkeys (
  id uuid NOT NULL DEFAULT uuidv7(),
  name text NULL,
  public_key text NOT NULL,
  user_id uuid NOT NULL,
  credential_id text NOT NULL,
  counter integer NOT NULL,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports text NULL,
  aaguid text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT passkeys_pkey PRIMARY KEY (id),
  CONSTRAINT passkeys_credential_id_key UNIQUE (credential_id),
  CONSTRAINT passkeys_user_fk FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE
);
-- FK + "passkeys of a user" lookup (sign-in options, list passkeys).
CREATE INDEX passkeys_user_idx ON identity.passkeys (user_id);

-- Least privilege: default privileges gave wb_app and friends DML on these tables at creation. Revoke everything from
-- everyone except wb_identity, then grant wb_identity DML.
REVOKE ALL ON identity.two_factors, identity.passkeys FROM PUBLIC, wb_app, wb_worker, wb_chainer;
GRANT SELECT, INSERT, UPDATE, DELETE ON identity.two_factors, identity.passkeys TO wb_identity;
