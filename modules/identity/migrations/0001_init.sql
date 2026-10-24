-- identity: GLOBAL schema (users, sessions, accounts, verifications) for Better Auth. See docs/adr/0010.
--
-- WHY NO RLS: the session is resolved BEFORE any tenant is known, so these tables cannot be tenant-scoped. The
-- protection is privilege separation instead: ONLY wb_identity (the identity module's own pool) can touch this
-- schema. wb_app and wb_worker get nothing: no schema USAGE, no table privileges. `rls-check` enforces this for every
-- schema listed in modules/registry.json "global".
--
-- IDs are UUIDv7: the app generates them (@wise-biz/ids via Better Auth advanced.database.generateId); uuidv7() is the
-- backstop default. Tables carry no tenant_id on purpose. Tenant context lives in tenancy.*; the only link is
-- sessions.active_tenant_id, which is deliberately NOT a foreign key (cross-module, and re-verified against
-- tenancy.memberships on every request, fail closed).
--
-- LATER MIGRATIONS: expand/contract, never edit a merged file. New tables created by wb_migrator get wb_app DML from the
-- cluster default privileges; the default-privilege tweak below only ADDS wb_identity, so every new identity table must
-- also `REVOKE ALL ON identity.<t> FROM wb_app, wb_worker` (rls-check fails the build otherwise).
CREATE SCHEMA identity AUTHORIZATION wb_migrator;
REVOKE ALL ON SCHEMA identity FROM PUBLIC;
GRANT USAGE ON SCHEMA identity TO wb_identity;

CREATE TABLE identity.users (
  id uuid NOT NULL DEFAULT uuidv7(),
  name text NOT NULL CHECK (length(name) <= 200),
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  email_verified boolean NOT NULL DEFAULT false,
  image text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_key UNIQUE (email)
);

-- CASCADE (here and on accounts): sessions and accounts are owned parts of the user with no life of their own.
CREATE TABLE identity.sessions (
  id uuid NOT NULL DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  ip_address text NULL,
  user_agent text NULL,
  active_tenant_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_pkey PRIMARY KEY (id),
  CONSTRAINT sessions_token_key UNIQUE (token),
  CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE
);
-- FK + "sessions of a user" (revoke all) lookup.
CREATE INDEX sessions_user_idx ON identity.sessions (user_id);
-- Expired-session sweep.
CREATE INDEX sessions_expires_idx ON identity.sessions (expires_at);

CREATE TABLE identity.accounts (
  id uuid NOT NULL DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  access_token text NULL,
  refresh_token text NULL,
  id_token text NULL,
  access_token_expires_at timestamptz NULL,
  refresh_token_expires_at timestamptz NULL,
  scope text NULL,
  password text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_pkey PRIMARY KEY (id),
  CONSTRAINT accounts_provider_account_key UNIQUE (provider_id, account_id),
  CONSTRAINT accounts_user_fk FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE CASCADE
);
CREATE INDEX accounts_user_idx ON identity.accounts (user_id);

CREATE TABLE identity.verifications (
  id uuid NOT NULL DEFAULT uuidv7(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verifications_pkey PRIMARY KEY (id)
);
CREATE INDEX verifications_identifier_idx ON identity.verifications (identifier);
-- Expired-verification sweep.
CREATE INDEX verifications_expires_idx ON identity.verifications (expires_at);

-- Least privilege: cluster default privileges gave wb_app DML on these tables the moment they were created. Remove it,
-- then grant wb_identity only. wb_worker never had any (explicit-grant role), revoked anyway for clarity.
REVOKE ALL ON ALL TABLES IN SCHEMA identity FROM PUBLIC, wb_app, wb_worker;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA identity FROM PUBLIC, wb_app, wb_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA identity TO wb_identity;
-- Tables added by later identity migrations get wb_identity DML automatically (wb_app must still be revoked there).
ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator IN SCHEMA identity
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wb_identity;
