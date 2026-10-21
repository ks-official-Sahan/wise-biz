-- DEV ONLY: passwords below are local-development placeholders. Never reuse them anywhere else.
-- Runs once on an empty volume (pnpm infra:reset to re-run).

CREATE ROLE wb_migrator WITH LOGIN PASSWORD 'wb_migrator' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE wb_app WITH LOGIN PASSWORD 'wb_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 200;
-- wb_worker: relay/consumer role (apps/workers). Reads and writes ACROSS tenants, but only through explicit
-- per-table policies `TO wb_worker` in module migrations (never BYPASSRLS). Default privileges give it nothing:
-- every table grant is explicit in the owning migration.
-- Dev URL: postgres://wb_worker:wb_worker@localhost:5432/wise_biz  (DATABASE_WORKER_URL)
CREATE ROLE wb_worker WITH LOGIN PASSWORD 'wb_worker' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 50;
ALTER ROLE wb_worker SET statement_timeout = '30s';
ALTER ROLE wb_worker SET idle_in_transaction_session_timeout = '60s';

-- wb_chainer: audit hash-chain worker (apps/workers audit-chainer). Reads audit rows across tenants and may fill ONLY
-- chain_seq/prev_hash/hash on unchained rows (column grant + trigger); no DELETE, no other table access beyond
-- audit.chain_heads / audit.anchors. Explicit `TO wb_chainer` policies, never BYPASSRLS.
-- Dev URL: postgres://wb_chainer:wb_chainer@localhost:5432/wise_biz  (DATABASE_CHAINER_URL)
CREATE ROLE wb_chainer WITH LOGIN PASSWORD 'wb_chainer' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 20;
ALTER ROLE wb_chainer SET statement_timeout = '30s';
ALTER ROLE wb_chainer SET idle_in_transaction_session_timeout = '60s';

-- Runtime guard rails, applied at login for every wb_app session (pools may override per connection).
-- search_path is deliberately NOT set to '': drizzle/pg queries are schema-qualified, but extension
-- functions (uuidv7 helpers, pgcrypto, pg_trgm, vector) live in public and must stay resolvable.
ALTER ROLE wb_app SET statement_timeout = '15s';
ALTER ROLE wb_app SET idle_in_transaction_session_timeout = '30s';

CREATE DATABASE wise_biz OWNER wb_migrator;

-- 002-extensions.sql revokes CONNECT from PUBLIC but only re-grants it to wb_app; wb_worker connects too.
GRANT CONNECT ON DATABASE wise_biz TO wb_worker;
GRANT CONNECT ON DATABASE wise_biz TO wb_chainer;
