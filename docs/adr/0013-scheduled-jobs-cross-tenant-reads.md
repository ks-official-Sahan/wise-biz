# ADR 0013: Scheduled module jobs find work across tenants through narrow wb_worker read policies

Status: accepted · 2026-10-29

## Context
P1-04 adds scheduled inventory jobs: batches entering an expiry horizon, a nightly drift check (re-derive balances from the ledger), and monthly partition upkeep. Event-driven work (projections, low-stock on `inventory.movement.recorded`) already runs per tenant inside the consumer transaction. A scheduled job has no event and so no tenant: it must first find which tenants have work. With FORCE RLS and an empty `app.tenant_id`, `wb_worker` sees no rows at all, and the table owner is subject to FORCE RLS too, so a SECURITY DEFINER function does not help.

## Decision
- A module may give `wb_worker` a **SELECT-only** policy `FOR SELECT TO wb_worker USING (true)` on the few tables its scheduled jobs scan to find work (inventory: `batches` for expiry, `stock_balances` for the tenant list of the drift check). No such policy for `wb_app`, never one for INSERT/UPDATE/DELETE.
- Everything a job **writes** (outbox events, debounce flags) happens in a per-tenant `withTenantTx` on the worker pool, so the `tenant_isolation` WITH CHECK still applies to every write (ADR 0012).
- Jobs are `createPeriodic` loops in the workers, each wrapped in a session advisory lock (`pg_try_advisory_lock`), so several worker replicas never run the same job at once. Daily jobs are idempotent: state on the row (`batches.expiry_alerted_on`) or deterministic event content keeps reruns harmless.
- `rls-check` accepts these policies because they are not reachable by `wb_app` or PUBLIC; each one is listed in the module migration with the job that needs it.

## Consequences
- A compromised worker could read stock levels and batch metadata of every tenant. It already relays every tenant's events, which carry the same data.
- Jobs scale with worker replicas without double work; a crashed job resumes on the next tick.
- Same pattern as the audit chainer's `wb_chainer` policies (ADR 0009), narrower (read only).
