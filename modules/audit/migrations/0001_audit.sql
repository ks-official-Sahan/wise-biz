-- audit: append-only, hash-chained audit log (security.md "Audit", ADR 0008 async chaining).
--
-- Roles
--   wb_app      INSERT only, inside the mutation transaction (no SELECT/UPDATE/DELETE/TRUNCATE).
--   wb_chainer  (apps/workers audit-chainer, NOBYPASSRLS) reads across tenants through `chainer_*` policies and may
--               fill chain_seq/prev_hash/hash exactly once per row (column grant + trigger). Never DELETE.
--   wb_migrator owns everything; partition DDL (create/detach/drop) is owner-only.
--
-- Chain order is chainer-assigned `chain_seq`, NOT the identity id: ids are allocated at INSERT but transactions commit
-- in a different order, so the chainer links rows in the order it sees them committed. A late-committing row simply
-- receives a higher chain_seq in a later pass. Verification walks chain_seq order.
--
-- Hash payload (the object passed to @wise-biz/audit-chain link(prevHash, payload)); rebuilt identically by the verifier:
--   { id: text(identity id), publicId: uuid text, tenantId: uuid text, actorType, actorId, action, entity,
--     entityId|null, before|null, after|null, reason|null, ip|null (host(ip), no mask), deviceId|null (uuid text),
--     requestId, at: UTC ISO-8601 with microseconds "YYYY-MM-DDTHH24:MI:SS.USZ" }
--
-- Rule exceptions: the PK includes the partition key (`at`), so (tenant_id, chain_seq) cannot be a unique index on a
-- partitioned table; uniqueness of chain_seq per tenant is guaranteed by the chainer (single writer per tenant under
-- the chain_heads row lock) and checked by the verifier (contiguity).
CREATE SCHEMA audit AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA audit TO wb_app, wb_chainer;

CREATE TABLE audit.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY,
  public_id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'device', 'system', 'mcp')),
  actor_id text NOT NULL CHECK (btrim(actor_id) <> '' AND length(actor_id) <= 200),
  action text NOT NULL CHECK (btrim(action) <> '' AND length(action) <= 200),
  entity text NOT NULL CHECK (btrim(entity) <> '' AND length(entity) <= 200),
  entity_id text CHECK (length(entity_id) <= 200),
  before jsonb CHECK (pg_column_size(before) <= 65536),
  after jsonb CHECK (pg_column_size(after) <= 65536),
  reason text CHECK (length(reason) <= 1000),
  ip inet,
  device_id uuid,
  request_id text NOT NULL CHECK (btrim(request_id) <> '' AND length(request_id) <= 200),
  at timestamptz NOT NULL DEFAULT now(),
  chain_seq bigint CHECK (chain_seq >= 1),
  prev_hash text CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text CHECK (hash ~ '^[0-9a-f]{64}$'),
  -- chained = all three set, unchained = none.
  CONSTRAINT audit_log_chain_all_or_none CHECK ((chain_seq IS NULL) = (hash IS NULL) AND (prev_hash IS NULL) = (hash IS NULL)),
  CONSTRAINT audit_log_pkey PRIMARY KEY (tenant_id, at, id)
) PARTITION BY RANGE (at);

-- Verification walk / anchor ranges.
CREATE INDEX audit_log_chain_idx ON audit.audit_log (tenant_id, chain_seq) WHERE chain_seq IS NOT NULL;
-- Chainer work queue: only unchained rows are indexed, so it stays tiny however much history exists.
CREATE INDEX audit_log_unchained_idx ON audit.audit_log (tenant_id, id) WHERE hash IS NULL;
-- "History of this entity" lookups.
CREATE INDEX audit_log_entity_idx ON audit.audit_log (tenant_id, entity, entity_id, at);

-- Append-only guard. DELETE never. UPDATE only the one-time chain fill (NULL -> value) with every other column intact.
CREATE FUNCTION audit.audit_log_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit.audit_log is append-only: DELETE rejected' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.hash IS NOT NULL OR OLD.chain_seq IS NOT NULL OR OLD.prev_hash IS NOT NULL THEN
    RAISE EXCEPTION 'audit.audit_log is append-only: chained row is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.hash IS NULL OR NEW.chain_seq IS NULL OR NEW.prev_hash IS NULL THEN
    RAISE EXCEPTION 'audit.audit_log is append-only: UPDATE may only set chain_seq, prev_hash and hash' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - '{chain_seq,prev_hash,hash}'::text[]) IS DISTINCT FROM (to_jsonb(OLD) - '{chain_seq,prev_hash,hash}'::text[]) THEN
    RAISE EXCEPTION 'audit.audit_log is append-only: only chain_seq, prev_hash and hash may change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- Row trigger on the partitioned parent is cloned onto every partition (including future ones).
CREATE TRIGGER audit_log_guard BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.audit_log_guard();

ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.audit_log USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY chainer_select ON audit.audit_log FOR SELECT TO wb_chainer USING (true);
CREATE POLICY chainer_update ON audit.audit_log FOR UPDATE TO wb_chainer USING (true) WITH CHECK (true);

REVOKE ALL ON audit.audit_log FROM PUBLIC, wb_app, wb_chainer;
GRANT INSERT ON audit.audit_log TO wb_app;
GRANT SELECT ON audit.audit_log TO wb_chainer;
GRANT UPDATE (chain_seq, prev_hash, hash) ON audit.audit_log TO wb_chainer;

-- Partition maintenance. SECURITY DEFINER (owner wb_migrator) so the chainer role can create partitions without
-- owning the table. Idempotent; returns how many partitions it created. Months are UTC.
CREATE FUNCTION audit.ensure_partitions(months_ahead int) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
DECLARE
  i int;
  lo timestamptz;
  hi timestamptz;
  part text;
  created int := 0;
  tenant_expr constant text := 'tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid';
BEGIN
  IF months_ahead IS NULL OR months_ahead < 0 OR months_ahead > 24 THEN
    RAISE EXCEPTION 'ensure_partitions: months_ahead must be between 0 and 24';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('audit.ensure_partitions', 0));
  FOR i IN 0..months_ahead LOOP
    lo := (date_trunc('month', timezone('UTC', now())) + make_interval(months => i)) AT TIME ZONE 'UTC';
    hi := (date_trunc('month', timezone('UTC', now())) + make_interval(months => i + 1)) AT TIME ZONE 'UTC';
    part := 'audit_log_' || to_char(timezone('UTC', lo), '"y"YYYY"m"MM');
    IF to_regclass(format('audit.%I', part)) IS NULL THEN
      EXECUTE format('CREATE TABLE audit.%I PARTITION OF audit.audit_log FOR VALUES FROM (%L) TO (%L)',
        part, to_char(timezone('UTC', lo), 'YYYY-MM-DD HH24:MI:SS') || '+00', to_char(timezone('UTC', hi), 'YYYY-MM-DD HH24:MI:SS') || '+00');
      -- A direct query on a partition ignores the parent's policies: each partition carries its own.
      EXECUTE format('ALTER TABLE audit.%I ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format('ALTER TABLE audit.%I FORCE ROW LEVEL SECURITY', part);
      EXECUTE format('CREATE POLICY tenant_isolation ON audit.%I USING (%s) WITH CHECK (%s)', part, tenant_expr, tenant_expr);
      EXECUTE format('CREATE POLICY chainer_select ON audit.%I FOR SELECT TO wb_chainer USING (true)', part);
      EXECUTE format('CREATE POLICY chainer_update ON audit.%I FOR UPDATE TO wb_chainer USING (true) WITH CHECK (true)', part);
      EXECUTE format('REVOKE ALL ON audit.%I FROM PUBLIC, wb_app, wb_chainer', part);
      EXECUTE format('GRANT INSERT ON audit.%I TO wb_app', part);
      EXECUTE format('GRANT SELECT ON audit.%I TO wb_chainer', part);
      EXECUTE format('GRANT UPDATE (chain_seq, prev_hash, hash) ON audit.%I TO wb_chainer', part);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;
REVOKE ALL ON FUNCTION audit.ensure_partitions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.ensure_partitions(int) TO wb_chainer;

SELECT audit.ensure_partitions(3);

-- Chainer cursor: last assigned chain_seq and head hash per tenant. Row lock = per-tenant chainer mutex.
CREATE TABLE audit.chain_heads (
  tenant_id uuid NOT NULL,
  chain_seq bigint NOT NULL CHECK (chain_seq >= 0),
  head_hash text NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chain_heads_pkey PRIMARY KEY (tenant_id)
);
ALTER TABLE audit.chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.chain_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.chain_heads USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY chainer_select ON audit.chain_heads FOR SELECT TO wb_chainer USING (true);
CREATE POLICY chainer_insert ON audit.chain_heads FOR INSERT TO wb_chainer WITH CHECK (true);
CREATE POLICY chainer_update ON audit.chain_heads FOR UPDATE TO wb_chainer USING (true) WITH CHECK (true);
REVOKE ALL ON audit.chain_heads FROM PUBLIC, wb_app, wb_chainer;
GRANT SELECT, INSERT ON audit.chain_heads TO wb_chainer;
GRANT UPDATE (chain_seq, head_hash, updated_at) ON audit.chain_heads TO wb_chainer;

-- Daily Merkle anchors over chain hashes. Append-only. Signing + WORM export is a follow-up job.
CREATE TABLE audit.anchors (
  tenant_id uuid NOT NULL,
  day date NOT NULL,
  chain_seq_from bigint NOT NULL,
  chain_seq_to bigint NOT NULL,
  row_count int NOT NULL CHECK (row_count >= 1),
  merkle_root text NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  head_hash text NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchors_pkey PRIMARY KEY (tenant_id, day),
  CONSTRAINT anchors_range_ok CHECK (chain_seq_to >= chain_seq_from)
);
CREATE FUNCTION audit.reject_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only: % rejected', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER anchors_append_only BEFORE UPDATE OR DELETE ON audit.anchors
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
ALTER TABLE audit.anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.anchors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.anchors USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY chainer_select ON audit.anchors FOR SELECT TO wb_chainer USING (true);
CREATE POLICY chainer_insert ON audit.anchors FOR INSERT TO wb_chainer WITH CHECK (true);
REVOKE ALL ON audit.anchors FROM PUBLIC, wb_app, wb_chainer;
GRANT SELECT, INSERT ON audit.anchors TO wb_chainer;
