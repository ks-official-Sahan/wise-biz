-- tenancy 0003: business profile, onboarding state, branch and location lifecycle (P0-10 console).
--
-- Expand-only: every new column is NULL or has a default, so running code keeps working while this applies.
-- Business defaults live on the tenant (country, currency, timezone, tax region); branches keep their own copies
-- because a branch may differ (time zone, tax region) and checkout reads only the branch.
-- The onboarding draft is a row in tenancy.settings (key 'onboarding.draft'), which already has RLS and grants.
-- Archive instead of delete: sales, stock and audit rows reference branches and locations forever.

ALTER TABLE tenancy.tenants
  ADD COLUMN country char(2) NULL CHECK (country ~ '^[A-Z]{2}$'),
  ADD COLUMN currency char(3) NULL CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN timezone text NULL CHECK (length(timezone) <= 64),
  ADD COLUMN tax_region text NULL CHECK (length(tax_region) <= 32),
  ADD COLUMN onboarded_at timestamptz NULL;

ALTER TABLE tenancy.branches
  ADD COLUMN archived_at timestamptz NULL;

ALTER TABLE tenancy.locations
  ADD COLUMN kind text NOT NULL DEFAULT 'sales_floor'
    CHECK (kind IN ('sales_floor', 'backroom', 'warehouse')),
  ADD COLUMN archived_at timestamptz NULL;

-- No backfill: FORCE RLS hides every row from the migrator, and pre-release tenants simply see onboarding once.

-- Column grants for the new use cases (UPDATE stays column-scoped; see 0001).
GRANT UPDATE (country, currency, timezone, tax_region, onboarded_at) ON tenancy.tenants TO wb_app;
GRANT UPDATE (archived_at) ON tenancy.branches TO wb_app;
GRANT UPDATE (name, kind, archived_at) ON tenancy.locations TO wb_app;
