-- sync (pull): the per-tenant change feed and bootstrap snapshots. See offline-sync.md, "Down: delta pull".
--
--   * Producers' events are fat (the entity travels in the event), so a change row carries its payload: pull reads one
--     table, never another module's. Rows are filled by the `sync.changes` consumer in the workers.
--   * The cursor is (txid, id), not a timestamp or a sequence. A row is readable only when its transaction id is below
--     the oldest transaction still in flight (pg_snapshot_xmin), so a slow writer that commits late can never appear
--     behind a cursor a device already moved past: no gaps, no repeats, whatever the consumer concurrency.
--   * scope_key is 'all', a branch id, or a location id (stock). Pull resolves a terminal's branch to its locations.
--   * Compaction (keep the newest row per entity below a floor cursor) is a follow-up job; snapshots already read the
--     newest row per entity.
CREATE TABLE sync.sync_changes (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  dataset text NOT NULL CHECK (dataset IN ('catalog', 'prices', 'tax', 'promotions', 'stock_branch', 'customers_recent',
    'policy_snapshot', 'entitlements', 'theme', 'receipt_template')),
  scope_key text NOT NULL DEFAULT 'all' CHECK (length(scope_key) <= 64),
  entity text NOT NULL CHECK (length(entity) BETWEEN 1 AND 40),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 200),
  op text NOT NULL CHECK (op IN ('upsert', 'delete')),
  version bigint NOT NULL DEFAULT 0,
  payload jsonb,
  changed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_changes_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT sync_changes_payload_op CHECK ((op = 'delete') = (payload IS NULL))
);
-- The pull scan: one dataset of one tenant in cursor order.
CREATE INDEX sync_changes_pull_idx ON sync.sync_changes (tenant_id, dataset, txid, id);
-- The snapshot: newest row per entity.
CREATE INDEX sync_changes_entity_idx ON sync.sync_changes (tenant_id, dataset, entity, entity_id, txid DESC, id DESC);

CREATE TABLE sync.snapshots (
  tenant_id uuid NOT NULL,
  dataset text NOT NULL,
  -- 'all' for branch-independent datasets, else the branch id (stock is per branch).
  scope_key text NOT NULL,
  -- The pull cursor the snapshot is consistent with: the device continues from here.
  cursor text NOT NULL,
  object_key text NOT NULL,
  entity_count integer NOT NULL CHECK (entity_count >= 0),
  bytes integer NOT NULL CHECK (bytes >= 0),
  built_at timestamptz NOT NULL,
  CONSTRAINT snapshots_pkey PRIMARY KEY (tenant_id, dataset, scope_key)
);

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "sync"."sync_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."sync_changes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sync"."sync_changes" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sync"."snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sync"."snapshots" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege: the feed is append-only; the workers write it, the API reads it (and writes snapshot rows).
REVOKE UPDATE, DELETE, TRUNCATE ON sync.sync_changes, sync.snapshots FROM wb_app;
GRANT SELECT ON sync.sync_changes TO wb_app;
GRANT SELECT, INSERT ON sync.snapshots TO wb_app;
GRANT UPDATE (cursor, object_key, entity_count, bytes, built_at) ON sync.snapshots TO wb_app;
GRANT USAGE ON SCHEMA sync TO wb_worker;
GRANT SELECT, INSERT ON sync.sync_changes TO wb_worker;
