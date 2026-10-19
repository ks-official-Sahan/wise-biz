-- DEV ONLY: see 001-roles-db.sql. Runs as the bootstrap superuser (postgres).
\connect wise_biz

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

REVOKE ALL ON DATABASE wise_biz FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE wise_biz TO wb_app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO wb_app;
ALTER SCHEMA public OWNER TO wb_migrator;

-- wb_app gets DML only (never DDL). Applies to objects wb_migrator creates later.
ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wb_app;
