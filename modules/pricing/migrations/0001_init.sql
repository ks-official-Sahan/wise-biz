-- pricing: price lists, prices, tax regions and rules, fees, promotions, coupons, FX rates, and a variant-facts
-- projection fed by catalog.variant.upserted (pricing never reads catalog tables). Pattern from modules/_template.
--
-- Decisions:
--   * Money is bigint minor units in the price list's currency (ADR 0005). Rates are basis points (10_000 = 100 %).
--   * A price list carries its tax region: currency and tax go together (one region per list). Branch and customer
--     group narrow where a list applies; the caller picks the list (quote takes priceListId).
--   * prices.version on the list is the engine's snapshot id (`<listId>:<version>`): every price write bumps it, so
--     device caches of line bases invalidate.
--   * Promotions are drafts until published; a published promotion is immutable (only archived). Its target and effect
--     are jsonb validated by the API against the engine's types (one source of truth: @wise-biz/pricing-engine).
--   * Coupons: a code belongs to one promotion. Max uses are checked by the quote; the use counter moves when a sale
--     completes (sales module, P1-05) through this module's contract, never here.
--   * FX rates are append-only (a new row per change); the latest valid_from <= now wins.
CREATE SCHEMA pricing AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA pricing TO wb_app, wb_worker;

CREATE TABLE pricing.tax_regions (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z0-9_.-]{1,32}$'),
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  inclusive boolean NOT NULL,
  strategy text NOT NULL CHECK (strategy IN ('per-line', 'per-document')),
  rounding_mode text NOT NULL DEFAULT 'half-even' CHECK (rounding_mode IN ('half-even', 'half-up', 'up', 'down')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_regions_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT tax_regions_code_key UNIQUE (tenant_id, code)
);

-- Replaced as a set when the region changes (the engine validates the whole policy).
CREATE TABLE pricing.tax_rules (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  region_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 60),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 100000),
  compound boolean NOT NULL DEFAULT false,
  categories text[] NOT NULL CHECK (cardinality(categories) BETWEEN 1 AND 50),
  ord smallint NOT NULL CHECK (ord BETWEEN 0 AND 99),
  CONSTRAINT tax_rules_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT tax_rules_region_fk FOREIGN KEY (tenant_id, region_id) REFERENCES pricing.tax_regions (tenant_id, id)
);
CREATE INDEX tax_rules_tenant_region_idx ON pricing.tax_rules (tenant_id, region_id, ord, id);

CREATE TABLE pricing.price_lists (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  tax_region_id uuid NOT NULL,
  branch_id uuid,
  customer_group text CHECK (length(customer_group) BETWEEN 1 AND 60),
  valid_from timestamptz,
  valid_to timestamptz,
  cash_increment_minor integer CHECK (cash_increment_minor BETWEEN 1 AND 100000),
  version integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_lists_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT price_lists_region_fk FOREIGN KEY (tenant_id, tax_region_id) REFERENCES pricing.tax_regions (tenant_id, id),
  CONSTRAINT price_lists_window CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);
CREATE INDEX price_lists_tenant_region_idx ON pricing.price_lists (tenant_id, tax_region_id);

CREATE TABLE pricing.prices (
  tenant_id uuid NOT NULL,
  price_list_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0 AND price_minor <= 9007199254740991),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prices_pkey PRIMARY KEY (tenant_id, price_list_id, variant_id),
  CONSTRAINT prices_list_fk FOREIGN KEY (tenant_id, price_list_id) REFERENCES pricing.price_lists (tenant_id, id)
);

CREATE TABLE pricing.fees (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 60),
  kind text NOT NULL CHECK (kind IN ('percent', 'amount')),
  value bigint NOT NULL CHECK (value >= 0 AND (kind = 'amount' OR value <= 10000)),
  tax_category text NOT NULL CHECK (length(tax_category) BETWEEN 1 AND 40),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fees_pkey PRIMARY KEY (tenant_id, id)
);
-- Every quote loads the active fees.
CREATE INDEX fees_tenant_active_idx ON pricing.fees (tenant_id, lower(name), id) WHERE active;

CREATE TABLE pricing.promotions (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000 AND 1000),
  stackable boolean NOT NULL DEFAULT true,
  target jsonb NOT NULL,
  effect jsonb NOT NULL,
  requires_coupon boolean NOT NULL DEFAULT false,
  customer_groups text[],
  starts_at timestamptz,
  ends_at timestamptz,
  min_qty text CHECK (min_qty ~ '^\d{1,14}(\.\d{1,4})?$'),
  min_amount_minor bigint CHECK (min_amount_minor >= 0),
  version integer NOT NULL DEFAULT 1,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promotions_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT promotions_window CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  -- An archived promotion keeps published_at only if it was ever published.
  CONSTRAINT promotions_published CHECK ((status <> 'draft' OR published_at IS NULL) AND (status <> 'published' OR published_at IS NOT NULL))
);
-- The quote loads every published promotion of a tenant (tens, not thousands); drafts never reach the engine.
CREATE INDEX promotions_tenant_published_idx ON pricing.promotions (tenant_id, priority DESC, id) WHERE status = 'published';
CREATE INDEX promotions_tenant_id_idx ON pricing.promotions (tenant_id, id);

CREATE TABLE pricing.coupons (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  promotion_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{3,32}$'),
  max_uses integer CHECK (max_uses >= 1),
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupons_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT coupons_promotion_fk FOREIGN KEY (tenant_id, promotion_id) REFERENCES pricing.promotions (tenant_id, id),
  -- The sale-time increment is a conditional UPDATE; this is the backstop against a double spend.
  CONSTRAINT coupons_uses_cap CHECK (max_uses IS NULL OR uses <= max_uses)
);
CREATE UNIQUE INDEX coupons_code_key ON pricing.coupons (tenant_id, lower(code));
CREATE INDEX coupons_tenant_promotion_idx ON pricing.coupons (tenant_id, promotion_id, id);

CREATE TABLE pricing.fx_rates (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  base char(3) NOT NULL CHECK (base ~ '^[A-Z]{3}$'),
  quote char(3) NOT NULL CHECK (quote ~ '^[A-Z]{3}$'),
  -- 1 base = rate quote.
  rate numeric(20,10) NOT NULL CHECK (rate > 0),
  valid_from timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'provider')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT fx_rates_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT fx_rates_distinct CHECK (base <> quote)
);
CREATE INDEX fx_rates_tenant_pair_idx ON pricing.fx_rates (tenant_id, base, quote, valid_from DESC, id DESC);

-- Projection of catalog.variant.upserted: what the quote needs per variant (consumer pricing.variant-facts).
CREATE TABLE pricing.variant_facts (
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  tax_category text NOT NULL,
  category_ids text[] NOT NULL DEFAULT '{}',
  archived boolean NOT NULL DEFAULT false,
  source_time timestamptz NOT NULL,
  CONSTRAINT variant_facts_pkey PRIMARY KEY (tenant_id, variant_id)
);

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "pricing"."tax_regions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."tax_regions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pricing"."tax_regions" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pricing"."tax_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."tax_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pricing"."tax_rules" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pricing"."price_lists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."price_lists" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pricing"."price_lists" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pricing"."prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."prices" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pricing"."prices" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pricing"."fees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."fees" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pricing"."fees" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pricing"."promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."promotions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pricing"."promotions" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pricing"."coupons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."coupons" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pricing"."coupons" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pricing"."fx_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."fx_rates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pricing"."fx_rates" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "pricing"."variant_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pricing"."variant_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pricing"."variant_facts" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege: master data is versioned and updated in place; only prices (removed from a list) and a region's
-- rule set (replaced as a whole) are deleted. FX rates are append-only.
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA pricing FROM wb_app;
GRANT UPDATE (name, inclusive, strategy, rounding_mode, version, updated_at) ON pricing.tax_regions TO wb_app;
GRANT DELETE ON pricing.tax_rules TO wb_app;
GRANT UPDATE (name, tax_region_id, branch_id, customer_group, valid_from, valid_to, cash_increment_minor, version,
  archived_at, updated_at) ON pricing.price_lists TO wb_app;
GRANT UPDATE (price_minor, updated_at) ON pricing.prices TO wb_app;
GRANT DELETE ON pricing.prices TO wb_app;
GRANT UPDATE (name, kind, value, tax_category, active, version, updated_at) ON pricing.fees TO wb_app;
GRANT UPDATE (name, status, priority, stackable, target, effect, requires_coupon, customer_groups, starts_at, ends_at,
  min_qty, min_amount_minor, version, published_at, updated_at) ON pricing.promotions TO wb_app;
-- uses: moved only by the sales module's completion path (P1-05) through this module's contract (same API role).
GRANT UPDATE (max_uses, active, uses) ON pricing.coupons TO wb_app;
-- The projection: read by the API, maintained by the worker (tenant-scoped, so the same policy applies).
REVOKE ALL ON pricing.variant_facts FROM wb_app, wb_worker;
GRANT SELECT ON pricing.variant_facts TO wb_app;
GRANT SELECT, INSERT, UPDATE ON pricing.variant_facts TO wb_worker;
