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
  topic text NOT NULL CHECK (btrim(topic) <> ''),
  key text NOT NULL,
  type text NOT NULL CHECK (btrim(type) <> ''),
  version int NOT NULL CHECK (version >= 1),
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  CONSTRAINT outbox_pkey PRIMARY KEY (tenant_id, id)
);

-- Relay scan: the worker polls ALL tenants in arrival order, so tenant_id deliberately does not lead (documented
-- exception to the tenant-first rule). Partial: only unpublished rows are indexed, so it stays tiny however much
-- history the table holds.
CREATE INDEX outbox_unpublished_idx ON infra.outbox (created_at, id) WHERE published_at IS NULL;

ALTER TABLE "infra"."outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra"."outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "infra"."outbox" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY worker_relay ON infra.outbox FOR ALL TO wb_worker USING (true) WITH CHECK (true);

REVOKE ALL ON infra.outbox FROM wb_app, wb_worker;
GRANT INSERT ON infra.outbox TO wb_app;
GRANT SELECT ON infra.outbox TO wb_worker;
GRANT UPDATE (published_at, attempts) ON infra.outbox TO wb_worker;

-- Consumer idempotency: first insert for (consumer, event_id) wins. The PK has no tenant_id: event ids are globally
-- unique UUIDv7 and the lookup is by (consumer, event_id) only (documented exception).
CREATE TABLE infra.processed_events (
  tenant_id uuid NOT NULL,
  consumer text NOT NULL CHECK (btrim(consumer) <> ''),
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT processed_events_pkey PRIMARY KEY (consumer, event_id)
);
-- Per-tenant retention sweeps / audit.
CREATE INDEX processed_events_tenant_time_idx ON infra.processed_events (tenant_id, processed_at);

ALTER TABLE "infra"."processed_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra"."processed_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "infra"."processed_events" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY worker_consume ON infra.processed_events FOR ALL TO wb_worker USING (true) WITH CHECK (true);

REVOKE ALL ON infra.processed_events FROM wb_app, wb_worker;
GRANT SELECT, INSERT ON infra.processed_events TO wb_worker;

-- Events that exhausted retries. error is a truncated message (no stack, no PII); payload kept for replay.
CREATE TABLE infra.dead_letters (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  consumer text NOT NULL CHECK (btrim(consumer) <> ''),
  event_id uuid NOT NULL,
  error text NOT NULL,
  attempts int NOT NULL,
  payload jsonb NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dead_letters_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT dead_letters_consumer_event_key UNIQUE (consumer, event_id)
);

ALTER TABLE "infra"."dead_letters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "infra"."dead_letters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "infra"."dead_letters" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY worker_dlq ON infra.dead_letters FOR ALL TO wb_worker USING (true) WITH CHECK (true);

REVOKE ALL ON infra.dead_letters FROM wb_app, wb_worker;
GRANT SELECT, INSERT, DELETE ON infra.dead_letters TO wb_worker;
