-- sync (push): per-device chain state and the command log. See docs/adr/0003-custom-sync.md and offline-sync.md.
--
--   * device_sync_state holds the last accepted (seq, hash) of each terminal. A batch takes the row FOR UPDATE, so
--     two batches of one device serialize and the chain can never fork. last_seq -1 / zero hash is the genesis.
--   * sync_log is the idempotency store: one row per accepted or rejected command, keyed by (device, seq), with the
--     answer that went back. A resent batch replays it; the same seq with another hash is a chain break.
--   * A command rejected by a business rule still advances the chain (it was signed and in order); its row says why.
--     Domain rows of a rejected command are rolled back (savepoint), the log row and the chain move stay.
CREATE SCHEMA sync AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA sync TO wb_app;

CREATE TABLE sync.device_sync_state (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  last_seq bigint NOT NULL DEFAULT -1 CHECK (last_seq >= -1),
  last_hash bytea NOT NULL DEFAULT '\x0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (length(last_hash) = 32),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_sync_state_pkey PRIMARY KEY (tenant_id, device_id)
);

CREATE TABLE sync.sync_log (
  tenant_id uuid NOT NULL,
  device_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 0),
  command_id uuid,
  type text NOT NULL CHECK (length(type) <= 40),
  hash bytea NOT NULL CHECK (length(hash) = 32),
  status text NOT NULL CHECK (status IN ('applied', 'replayed', 'rejected')),
  result jsonb,
  error jsonb,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_log_pkey PRIMARY KEY (tenant_id, device_id, seq)
);
-- Look a command up by its id (support, "where is my sale?").
CREATE INDEX sync_log_command_idx ON sync.sync_log (tenant_id, command_id) WHERE command_id IS NOT NULL;
-- Prune by age across tenants (worker job, retention per the data-model retention table).
CREATE INDEX sync_log_applied_idx ON sync.sync_log (applied_at);

-- The chain only moves forward, by exactly one accepted command: no code path of the app role can rewind or skip it.
CREATE FUNCTION sync.chain_moves_forward() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_seq <> OLD.last_seq + 1 THEN
    RAISE EXCEPTION 'sync chain must advance by one (% -> %)', OLD.last_seq, NEW.last_seq USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER device_sync_state_forward BEFORE UPDATE ON sync.device_sync_state
  FOR EACH ROW EXECUTE FUNCTION sync.chain_moves_forward();

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "sync"."device_sync_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."device_sync_state" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sync"."device_sync_state" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sync"."sync_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sync"."sync_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sync"."sync_log" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege: the log is insert-only; the state moves only forward through these columns.
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA sync FROM wb_app;
GRANT SELECT, INSERT ON sync.sync_log TO wb_app;
GRANT SELECT, INSERT ON sync.device_sync_state TO wb_app;
GRANT UPDATE (last_seq, last_hash, updated_at) ON sync.device_sync_state TO wb_app;
