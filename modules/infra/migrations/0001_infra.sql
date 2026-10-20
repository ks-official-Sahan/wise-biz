-- infra: cross-cutting delivery tables (outbox, consumer idempotency, dead letters).
--
-- Roles: wb_app (API) only appends to the outbox inside the mutation transaction. wb_worker (apps/workers, NOBYPASSRLS)
-- relays and consumes across tenants through the explicit `worker_*` policies below. Default privileges hand wb_app
-- DML on everything wb_migrator creates, so each table revokes first and grants back exactly what is needed.
-- Rule exceptions (cross-tenant scans, so tenant_id cannot lead): outbox_unpublished_idx and processed_events' PK.
CREATE SCHEMA infra AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA infra TO wb_app, wb_worker;

-- Transactional outbox. id = the event id (UUIDv7, client/producer supplied) so consumers dedupe on it.
CREATE TABLE infra.outbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  topic text NOT NULL CHECK (btrim(topic) <> '' AND length(topic) <= 200),
  key text NOT NULL CHECK (length(key) <= 500),
  type text NOT NULL CHECK (btrim(type) <> '' AND length(type) <= 200),
  version int NOT NULL CHECK (version >= 1),
  payload jsonb NOT NULL CHECK (pg_column_size(payload) <= 262144),
  headers jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(headers) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  -- Relay lease: a claimer owns the row until claimed_until; an expired lease is reclaimable.
  claimed_until timestamptz,
  claimed_by text,
  -- Poison rows (attempts exhausted) leave the relay index until an operator clears this.
  quarantined_at timestamptz,
  CONSTRAINT outbox_pkey PRIMARY KEY (tenant_id, id)
) WITH (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_delay = 0);

-- Relay scan: the worker polls ALL tenants in arrival order, so tenant_id deliberately does not lead (documented
-- exception to the tenant-first rule). Partial: only unpublished rows are indexed, so it stays tiny however much
-- history the table holds.
CREATE INDEX outbox_unpublished_idx ON infra.outbox (created_at, id)
  WHERE published_at IS NULL AND quarantined_at IS NULL;
-- Retention prune: oldest published rows first, without scanning the live tail.
CREATE INDEX outbox_published_idx ON infra.outbox (published_at) WHERE published_at IS NOT NULL;

ALTER TABLE "infra"."outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra"."outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "infra"."outbox" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY worker_select ON infra.outbox FOR SELECT TO wb_worker USING (true);
CREATE POLICY worker_update ON infra.outbox FOR UPDATE TO wb_worker USING (true) WITH CHECK (true);
CREATE POLICY worker_delete ON infra.outbox FOR DELETE TO wb_worker USING (true);

REVOKE ALL ON infra.outbox FROM wb_app, wb_worker;
GRANT INSERT ON infra.outbox TO wb_app;
GRANT SELECT ON infra.outbox TO wb_worker;
GRANT UPDATE (published_at, attempts, claimed_until, claimed_by, quarantined_at) ON infra.outbox TO wb_worker;
GRANT DELETE ON infra.outbox TO wb_worker;

-- Consumer idempotency: first insert for (consumer, tenant_id, event_id) wins. Event ids are producer-supplied, so
-- tenant_id is part of the key: one tenant can never suppress another tenant's event (documented exception: the
-- consumer leads the key, since lookups always name the consumer).
CREATE TABLE infra.processed_events (
  tenant_id uuid NOT NULL,
  consumer text NOT NULL CHECK (btrim(consumer) <> ''),
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, tenant_id, event_id)
);
-- Retention prune scans oldest first, across tenants.
CREATE INDEX processed_events_processed_at_idx ON infra.processed_events (processed_at);

ALTER TABLE "infra"."processed_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra"."processed_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "infra"."processed_events" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY worker_select ON infra.processed_events FOR SELECT TO wb_worker USING (true);
CREATE POLICY worker_insert ON infra.processed_events FOR INSERT TO wb_worker WITH CHECK (true);
CREATE POLICY worker_delete ON infra.processed_events FOR DELETE TO wb_worker USING (true);

REVOKE ALL ON infra.processed_events FROM wb_app, wb_worker;
GRANT SELECT, INSERT, DELETE ON infra.processed_events TO wb_worker;

-- Events that exhausted retries. error is a truncated message (no stack, no PII); payload kept for replay.
CREATE TABLE infra.dead_letters (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  consumer text NOT NULL CHECK (btrim(consumer) <> ''),
  event_id uuid NOT NULL,
  error text NOT NULL CHECK (length(error) <= 1000),
  attempts int NOT NULL,
  payload jsonb NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dead_letters_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT dead_letters_consumer_event_key UNIQUE (consumer, tenant_id, event_id)
);

ALTER TABLE "infra"."dead_letters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra"."dead_letters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "infra"."dead_letters" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY worker_select ON infra.dead_letters FOR SELECT TO wb_worker USING (true);
CREATE POLICY worker_insert ON infra.dead_letters FOR INSERT TO wb_worker WITH CHECK (true);
CREATE POLICY worker_update ON infra.dead_letters FOR UPDATE TO wb_worker USING (true) WITH CHECK (true);
CREATE POLICY worker_delete ON infra.dead_letters FOR DELETE TO wb_worker USING (true);

REVOKE ALL ON infra.dead_letters FROM wb_app, wb_worker;
GRANT SELECT, INSERT, DELETE ON infra.dead_letters TO wb_worker;
GRANT UPDATE (attempts, error, failed_at) ON infra.dead_letters TO wb_worker;
