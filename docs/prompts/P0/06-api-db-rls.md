# P0-06 · API skeleton, database layer, RLS

Effort: **H** · Needs: P0-02, P0-04 · Gate: confirm plan
Read: `ARCHITECTURE.md` (Request lifecycle, Module internals), `docs/adr/0001-modular-monolith.md`, `docs/adr/0004-postgres-uuidv7-rls.md`, `docs/architecture/data-model.md` (Principles, Index rules), `docs/architecture/api-conventions.md`
Libraries: Hono (Node adapter), `@hono/zod-openapi`, Drizzle ORM + drizzle-kit (Postgres driver choice: node-postgres vs postgres.js — pick one with pooling + `SET LOCAL` support), pino, OpenTelemetry Node SDK, Testcontainers
Skills: `ecc:hexagonal-architecture`, `ecc:postgres-patterns`, `ecc:database-migrations`, `ecc:api-design`

## Goal
A running `apps/api` that mounts modules, enforces tenant isolation at the database, and gives every later module a tested template to copy.

## Scope
1. **`@wise-biz/db`**:
   - Pool factory (runtime role `wb_app`), migrator using `wb_migrator`.
   - `withTenantTx(ctx, fn)`: begin → `set local app.tenant_id` (+ `app.user_id`, `app.request_id`) → fn → commit; rollback on throw. Also `withPlatformTx` for platform-only tables (explicit, audited).
   - Per-module migrations: each `modules/<m>/migrations/` applied in registry order; migration table per module; `pnpm db:migrate`, `pnpm db:migration <module> <name>`.
   - RLS helper: SQL snippet/generator that enables + forces RLS and creates the tenant policy for a table; a CI check that fails if any table in a module schema lacks RLS.
   - Query counter for tests (wraps the client, counts statements per scope) — used for N+1 assertions everywhere.
2. **`packages/testing`** additions: Testcontainers Postgres 18 (+ extensions) started once per run; template database cloned per test file for speed; Redis container; fake clock; seed helpers.
3. **`apps/api`**:
   - `createApp({ modules })`; `defineModule({ name, routes, migrationsDir, permissions, events, consumers })`.
   - Middleware order: request id → logger (pino, redacts secrets/PII) → OTel tracing → security headers → body limit → CORS (allowlist) → auth context (placeholder that sets an anonymous ctx; real auth P0-08) → tenant resolver → error handler (DomainError → RFC 9457).
   - `/health` (liveness) and `/ready` (DB + Redis).
   - OpenAPI generated from routes at `/openapi.json` (dev only) and into `packages/contracts/generated/openapi.json` via script.
4. **Example module `modules/_template`** (not mounted in prod): one table with RLS, one list endpoint with keyset pagination and `?include`, one create endpoint. It is the copy source for new modules; document in `docs/modules.md` "Adding a module".

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | Drizzle + driver + `SET LOCAL` pattern; drizzle-kit per-folder migrations; Hono + zod-openapi; Testcontainers PG 18 |
| 2 | wb-db (sonnet) | `packages/db/**` | Item 1 |
| 3 | wb-builder (sonnet) | `packages/testing/**` | Item 2 |
| 4 | wb-builder (sonnet) | `apps/api/**` | Item 3 (after 2–3 interfaces exist) |
| 5 | wb-builder (sonnet) | `modules/_template/**` | Item 4 |
| 6 | wb-tester (haiku) | `apps/api/test/**`, `modules/_template/test/**` | RLS isolation, query count, problem details, health |

## Acceptance
- `pnpm infra:up && pnpm db:migrate && pnpm -F api test` passes.
- RLS: tenant A cannot read or write tenant B rows via repository, raw SQL, or a missing tenant setting (returns zero rows).
- CI check fails when a new table lacks RLS (prove with a temporary migration).
- Template list endpoint with `?include=children` runs exactly 2 queries for 50 rows (query counter).
- `curl /health` 200; `/ready` 503 when Postgres is stopped.
- Errors return `application/problem+json` with stable `code`.

## Review
`ecc:database-reviewer`, `ecc:typescript-reviewer`, `ecc:security-reviewer`
