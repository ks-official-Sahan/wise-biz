-- DEV ONLY: see 001-roles-db.sql. Runs as the bootstrap superuser (postgres).
\connect wise_biz

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

REVOKE ALL ON DATABASE wise_biz FROM PUBLIC;
GRANT CONNECT ON DATABASE wise_biz TO wb_app;
-- No temp tables for the runtime role (also keeps PUBLIC from re-granting it).
REVOKE TEMPORARY ON DATABASE wise_biz FROM wb_app;
REVOKE TEMPORARY ON DATABASE wise_biz FROM PUBLIC;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO wb_app;
ALTER SCHEMA public OWNER TO wb_migrator;

-- wb_app gets DML only (never DDL) on everything wb_migrator creates later, in ANY schema
-- (no IN SCHEMA clause, so future module schemas are covered). USAGE on each module schema is NOT
-- covered here: every module migration must still `GRANT USAGE ON SCHEMA <m> TO wb_app`.
-- Append-only tables (ledgers, audit) must REVOKE UPDATE, DELETE, TRUNCATE from wb_app in their migration.
ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator
  GRANT USAGE, SELECT ON SEQUENCES TO wb_app;
