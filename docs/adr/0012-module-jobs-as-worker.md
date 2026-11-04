# ADR 0012: Long module jobs run in the workers as wb_worker

Status: accepted · 2026-10-29

## Context
Bulk catalog import (P1-02c) parses files of 10k+ rows. That cannot run inside an API request, and it cannot run inside one consumer transaction either: the pg bus wraps each delivery in one transaction with a 30 s timeout, and a timeout reruns the whole delivery. Until now `wb_worker` only relayed the outbox and maintained projections (search); it could not write module tables or append outbox events.

## Decision
- A module may own a job that the workers run. The API command that starts it (authorize → validate → idempotency → one transaction) writes the job row, its **audit row** and a `*.requested` outbox event, as every mutation does. The audit trail names the user, the file hash and the size; the job's own outcome (counts, report) lands on the job row.
- The event only triggers the job. The job runs **outside** the consumer transaction on a worker pool: each batch is its own tenant-scoped transaction (`app.tenant_id` set, RLS applies) that writes the module rows **and** their outbox events together, then records progress on the job row so a retry resumes instead of restarting.
- `wb_worker` gets, per module migration, only the grants its job needs on that module's tables (the existing "explicit grants `TO wb_worker`" rule of `001-roles-db.sql`), plus `INSERT` on `infra.outbox`. The outbox `tenant_isolation` policy (`WITH CHECK tenant_id = app.tenant_id`) applies to that insert; no `USING (true)` policy is added for it.
- `wb_worker` still has no audit grant: per-row audit stays with the user command (ADR 0009 unchanged).

## Consequences
- Imports and similar jobs scale with the worker fleet and never hold an API connection.
- A compromised worker could append events for the tenant it is scoped to; it already could alter projections and relay state. `rls-check` keeps the grants explicit and reviewed.
- Amends ADR 0006 only in who may append to the outbox (still always in the same transaction as the state change).
