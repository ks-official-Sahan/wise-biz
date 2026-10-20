-- DEV ONLY: passwords below are local-development placeholders. Never reuse them anywhere else.
-- Runs once on an empty volume (pnpm infra:reset to re-run).

CREATE ROLE wb_migrator WITH LOGIN PASSWORD 'wb_migrator' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE wb_app WITH LOGIN PASSWORD 'wb_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 200;

-- Runtime guard rails, applied at login for every wb_app session (pools may override per connection).
-- search_path is deliberately NOT set to '': drizzle/pg queries are schema-qualified, but extension
-- functions (uuidv7 helpers, pgcrypto, pg_trgm, vector) live in public and must stay resolvable.
ALTER ROLE wb_app SET statement_timeout = '15s';
ALTER ROLE wb_app SET idle_in_transaction_session_timeout = '30s';

CREATE DATABASE wise_biz OWNER wb_migrator;
