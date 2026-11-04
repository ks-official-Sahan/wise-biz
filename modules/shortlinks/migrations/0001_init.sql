-- shortlinks: public digital receipt pages (`/r/<CODE>`, CODE = receiptCode(saleId) from @wise-biz/receipt).
--
-- Decisions:
--   * One row per sale, written by the sales.sale.completed consumer (wb_worker, inside a tx scoped to the event's
--     tenant). Idempotent on (tenant_id, sale_id).
--   * `code` is GLOBALLY unique: the public page has no tenant, so the lookup has none either. The lookup runs only
--     through shortlinks.receipt_by_code (SECURITY DEFINER, owned by wb_migrator), which returns the snapshot and
--     nothing else. wb_app has no table privilege at all.
--   * `snapshot` is the public document: no customer, operator, terminal, branch or location ids.
--   * FORCE RLS applies to the owner too, so the function needs a narrow owner-only SELECT policy keyed on a
--     transaction-local GUC that the function sets to its own argument.
CREATE SCHEMA shortlinks AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA shortlinks TO wb_app, wb_worker;

CREATE TABLE shortlinks.receipt_links (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{10}$'),
  sale_id uuid NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_links_pkey PRIMARY KEY (tenant_id, id),
  -- Global: the public lookup key. Its unique index serves receipt_by_code.
  CONSTRAINT receipt_links_code_key UNIQUE (code),
  -- Idempotent projection: the consumer's ON CONFLICT target. A code collision between two sales raises instead.
  CONSTRAINT receipt_links_sale_key UNIQUE (tenant_id, sale_id)
);

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "shortlinks"."receipt_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shortlinks"."receipt_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "shortlinks"."receipt_links" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Owner-only read path for receipt_by_code. Not reachable by wb_app or PUBLIC (rls-check: the policy names neither).
CREATE POLICY public_lookup ON "shortlinks"."receipt_links" FOR SELECT TO wb_migrator
  USING ("code" = nullif(current_setting('shortlinks.public_code', true), ''));

-- Public lookup. SECURITY DEFINER (owner wb_migrator), pinned search_path, VOLATILE (it sets a GUC).
CREATE FUNCTION shortlinks.receipt_by_code(p_code text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = shortlinks, pg_catalog, pg_temp AS $$
DECLARE
  s jsonb;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[0-9A-HJKMNP-TV-Z]{10}$' THEN
    RETURN NULL;
  END IF;
  -- Transaction-local: the owner policy above admits exactly this code.
  PERFORM set_config('shortlinks.public_code', p_code, true);
  SELECT snapshot INTO s FROM shortlinks.receipt_links WHERE code = p_code;
  RETURN s;
END $$;

-- Least privilege. Default privileges would give wb_app and wb_worker DML, so revoke everything, then grant the
-- consumer INSERT only. wb_app reads through the function and nothing else.
REVOKE ALL ON shortlinks.receipt_links FROM wb_app, wb_worker;
-- ON CONFLICT (tenant_id, sale_id) needs SELECT on the conflict-target columns, nothing else.
GRANT INSERT, SELECT (tenant_id, sale_id) ON shortlinks.receipt_links TO wb_worker;
REVOKE ALL ON FUNCTION shortlinks.receipt_by_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shortlinks.receipt_by_code(text) TO wb_app;
