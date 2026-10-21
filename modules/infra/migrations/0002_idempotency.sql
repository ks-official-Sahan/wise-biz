-- infra.idempotency_keys: durable record of completed mutations, keyed by the client's Idempotency-Key.
--
-- Written INSIDE the mutation transaction (same commit as the domain write), so a rolled-back mutation leaves no key.
-- Concurrent duplicates are serialised by the caller with pg_advisory_xact_lock(tenant, key); Redis is only a response
-- cache in front of this table. Expired rows count as absent; wb_worker prunes them in batches.
-- wb_app UPDATE is column-limited and used only by `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now()`
-- (re-using an expired key). Rule exception: idempotency_keys_expires_idx leads with expires_at (cross-tenant pruning).
CREATE TABLE infra.idempotency_keys (
  tenant_id uuid NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 255),
  request_hash text NOT NULL CHECK (length(request_hash) BETWEEN 1 AND 128),
  status text NOT NULL CHECK (status IN ('completed')),
  response_status int NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  -- text, not jsonb: replays must be byte-identical and jsonb normalises key order/whitespace.
  response_body text NOT NULL CHECK (octet_length(response_body) <= 262144),
  response_headers jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(response_headers) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (tenant_id, key)
) WITH (autovacuum_vacuum_scale_factor = 0.02); -- high churn: vacuum at 2% dead rows, not 20%
CREATE INDEX idempotency_keys_expires_idx ON infra.idempotency_keys (expires_at);

ALTER TABLE "infra"."idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra"."idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "infra"."idempotency_keys" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY worker_select ON infra.idempotency_keys FOR SELECT TO wb_worker USING (true);
CREATE POLICY worker_delete ON infra.idempotency_keys FOR DELETE TO wb_worker USING (true);

REVOKE ALL ON infra.idempotency_keys FROM wb_app, wb_worker;
GRANT SELECT, INSERT ON infra.idempotency_keys TO wb_app;
GRANT UPDATE (request_hash, status, response_status, response_body, response_headers, created_at, expires_at) ON infra.idempotency_keys TO wb_app;
GRANT SELECT, DELETE ON infra.idempotency_keys TO wb_worker;
