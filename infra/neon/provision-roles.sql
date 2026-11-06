-- Production roles for Neon (or any managed Postgres). Same attributes as the dev init
-- (infra/docker/postgres/init/001-roles-db.sql) but NO default passwords: every password is a psql variable
-- you must pass, so this script cannot run with a guessable one. Never run the dev init file against production.
--
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 \
--     -v migrator_pw="$(openssl rand -base64 36)" -v app_pw="$(openssl rand -base64 36)" \
--     -v worker_pw="$(openssl rand -base64 36)" -v chainer_pw="$(openssl rand -base64 36)" \
--     -v identity_pw="$(openssl rand -base64 36)" -v dbname=wise_biz -f infra/neon/provision-roles.sql
--
-- Store each generated password straight into Secret Manager (docs/runbooks/rotate-secrets.md); do not echo them.
-- Create the database first (Neon console or CREATE DATABASE) and run this script connected to it as the owner role.

\if :{?migrator_pw} \else \echo 'pass -v migrator_pw=...' \quit \endif
\if :{?app_pw} \else \echo 'pass -v app_pw=...' \quit \endif
\if :{?worker_pw} \else \echo 'pass -v worker_pw=...' \quit \endif
\if :{?chainer_pw} \else \echo 'pass -v chainer_pw=...' \quit \endif
\if :{?identity_pw} \else \echo 'pass -v identity_pw=...' \quit \endif
\if :{?dbname} \else \echo 'pass -v dbname=...' \quit \endif

CREATE ROLE wb_migrator WITH LOGIN PASSWORD :'migrator_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE wb_app WITH LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 200;
CREATE ROLE wb_worker WITH LOGIN PASSWORD :'worker_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 50;
CREATE ROLE wb_chainer WITH LOGIN PASSWORD :'chainer_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 20;
CREATE ROLE wb_identity WITH LOGIN PASSWORD :'identity_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 50;

ALTER ROLE wb_app SET statement_timeout = '15s';
ALTER ROLE wb_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE wb_worker SET statement_timeout = '30s';
ALTER ROLE wb_worker SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE wb_chainer SET statement_timeout = '30s';
ALTER ROLE wb_chainer SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE wb_identity SET statement_timeout = '15s';
ALTER ROLE wb_identity SET idle_in_transaction_session_timeout = '30s';

ALTER DATABASE :"dbname" OWNER TO wb_migrator;
REVOKE CONNECT ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO wb_app, wb_worker, wb_chainer, wb_identity, wb_migrator;

-- The rest of the database setup (what infra/docker/postgres/init/002-extensions.sql does locally). Run connected to the
-- database as the owner. The extensions must be created by the owner: the migrator is not a superuser.
connect :"dbname"
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO wb_app, wb_worker, wb_chainer, wb_identity, wb_migrator;
REVOKE TEMPORARY ON DATABASE :"dbname" FROM wb_app;
REVOKE TEMPORARY ON DATABASE :"dbname" FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO wb_app;
ALTER SCHEMA public OWNER TO wb_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wb_migrator GRANT USAGE, SELECT ON SEQUENCES TO wb_app;
