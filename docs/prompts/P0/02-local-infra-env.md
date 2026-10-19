# P0-02 · Local infra (compose) + env schema

Effort: **M** · Needs: P0-01 · Gate: none
Read: `docs/architecture/deployment.md` (Environments, Containers), `docs/architecture/security.md` (Secrets row)
Libraries: Docker Compose, Postgres 18 image with pgvector, Redis, Redpanda, MinIO, Mailpit, zod
Skills: `ecc:docker-patterns`, `docker-compose-orchestration`

## Goal
`pnpm infra:up` starts every local dependency with health checks, and every app reads its environment through one typed, validated schema.

## Scope
1. `infra/docker/compose.yaml`:
   - `postgres` 18 with `pgvector` and `pg_trgm` available (pick an image tag that exists for PG 18; verify). `shared_preload_libraries=pg_stat_statements`. Volume, healthcheck.
   - `infra/docker/postgres/init/*.sql`: create roles `wb_migrator` (owns schemas) and `wb_app` (runtime: `NOSUPERUSER NOBYPASSRLS`, login), database `wise_biz`, extensions `pgcrypto`, `pg_trgm`, `vector`, `pg_stat_statements`.
   - `redis`, `redpanda` (+ console, profile `kafka`), `minio` (+ bucket bootstrap), `mailpit`. All with healthchecks and pinned tags.
2. `packages/env`: `defineEnv(schema)` returns a frozen typed object; fails fast listing all invalid keys without printing values; `assertProductionEnv()` (secret length ≥ 32, no `capture` email provider in prod; mirror the Sahan rule). Shared fragments: `databaseEnv`, `redisEnv`, `authEnv`, `storageEnv`, `emailEnv`, `observabilityEnv`.
3. `.env.example` at root with every key, comments, and `(required)` markers; `scripts/check-env-example.mts` fails when code schemas and `.env.example` disagree (never prints values).
4. Root scripts: `infra:up`, `infra:down`, `infra:reset` (asks for confirmation), `infra:logs`, `db:psql`.
5. `docs/architecture/deployment.md`: short "Local setup" section.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | Postgres 18 + pgvector image tags, Redpanda single-node dev flags, MinIO bucket init pattern |
| 2 | wb-scaffolder (haiku) | `infra/docker/**`, root scripts | Items 1, 4 |
| 3 | wb-builder (sonnet) | `packages/env/**`, `.env.example`, `scripts/check-env-example.mts` | Items 2–3 with tests |
| 4 | orchestrator | docs | Item 5 |

## Acceptance
- `pnpm infra:up` → all services healthy within 60 s (`docker compose ps`).
- `psql` as `wb_app`: `select rolbypassrls, rolsuper from pg_roles where rolname='wb_app'` → `f, f`.
- `select * from pg_extension` lists `vector`, `pg_trgm`, `pgcrypto`, `pg_stat_statements`.
- `pnpm -F @wise-biz/env test` passes; invalid env output names keys only.
- `pnpm tsx scripts/check-env-example.mts` passes, and fails after adding a key to a schema only.

## Review
`ecc:security-reviewer` (secrets handling only)
