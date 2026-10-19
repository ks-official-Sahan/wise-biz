-- DEV ONLY: passwords below are local-development placeholders. Never reuse them anywhere else.
-- Runs once on an empty volume (pnpm infra:reset to re-run).

CREATE ROLE wb_migrator WITH LOGIN PASSWORD 'wb_migrator' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE wb_app WITH LOGIN PASSWORD 'wb_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE DATABASE wise_biz OWNER wb_migrator;
