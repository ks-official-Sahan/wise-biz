# P0-07 · Outbox, events, idempotency, audit

Effort: **H** · Needs: P0-05, P0-06 · Gate: confirm plan
Read: `docs/architecture/events.md`, `docs/adr/0006-outbox-kafka.md`, `docs/architecture/security.md` (Audit), `docs/architecture/api-conventions.md` (Headers: Idempotency-Key)
Libraries: Drizzle, ioredis or `@upstash/redis` (match auth-kit cache adapter), pino
Skills: `ecc:backend-patterns`, `ecc:error-handling`, `ecc:latency-critical-systems`

## Goal
One helper that makes every mutation correct by construction: authorize → validate → idempotency → transaction (domain + audit + outbox) → result. Events reach consumers at least once and are processed exactly once.

## Scope
1. **Outbox** (schema `infra`): `outbox` table per events.md; insert helper used inside `withTenantTx`.
2. **`@wise-biz/events`**: `EventBus` port; adapters `memory` (tests) and `pg` (relay polls `for update skip locked`, batch 500). Kafka adapter is P2; keep the interface ready.
3. **`apps/workers`**: relay loop with graceful shutdown; consumer framework: `defineConsumer({ name, events, handle })`, `infra.processed_events (consumer, event_id)` unique for idempotency, retry with exponential backoff (3 tries) → `infra.dead_letters`; metrics hooks.
4. **Idempotency**: middleware for POST/PATCH: Redis fast path + `infra.idempotency_keys (tenant_id, key, request_hash, status, response, expires_at)`; same key + same body → stored response; same key + different body → 422 `IDEMPOTENCY_MISMATCH`; concurrent duplicates wait or get 409 `IN_PROGRESS`.
5. **Audit module** (`modules/audit`):
   - `audit.audit_log` partitioned by month, `id bigint generated always as identity` for ordering + `uuid` public id; columns per security.md; runtime role: INSERT only.
   - **Chaining is asynchronous** to avoid per-tenant lock contention on the hot path: rows insert without hash in the mutation transaction; worker `audit-chainer` processes each tenant's rows in `id` order every few seconds and fills `prev_hash`, `hash` via a dedicated role allowed to `UPDATE (prev_hash, hash)` only where `hash is null` (trigger enforces). Daily Merkle root stored in `audit.anchors`. Record this as **ADR 0008**.
   - Partition maintenance job (create next 3 months).
6. **`runCommand` helper** in `apps/api` (or `@wise-biz/app-kernel`): `runCommand(ctx, { permission, input: zodSchema, idempotency: true, handler: (tx, input) => { result, audit, events } })`.
7. Convert `modules/_template` create endpoint to `runCommand`.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-db (sonnet) | `modules/audit/migrations/**`, `packages/db/src/infra/**` | Tables, partitions, roles, trigger |
| 2 | wb-builder (sonnet) | `packages/events/**`, `apps/workers/**` | Items 2–3 |
| 3 | wb-builder (sonnet) | `apps/api/src/kernel/**` (idempotency, runCommand), `modules/audit/src/**` | Items 4–6 |
| 4 | wb-tester (haiku) | `**/test/**` for the above | Acceptance tests |
| 5 | orchestrator | `docs/adr/0008-async-audit-chaining.md`, events.md, security.md | Docs |

## Acceptance
- Rolled-back command leaves zero audit and outbox rows.
- Duplicate `Idempotency-Key` returns the identical response; different body → 422.
- An event delivered twice is handled once (`processed_events`).
- Chainer: hashes fill within 5 s; editing any audited row (as superuser in test) is detected by the verifier.
- Load smoke: 1,000 `runCommand` calls/s for 30 s on the template endpoint on a laptop with p95 < 50 ms and no lock waits in `pg_stat_activity` (autocannon or k6).

## Review
`ecc:database-reviewer`, `ecc:security-reviewer`, `ecc:silent-failure-hunter`
