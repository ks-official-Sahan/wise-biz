# ADR 0017: Hosting is Neon Postgres plus a managed container platform

Status: accepted · 2026-11-04 (owner's choice; the specific container platform is still to be named)

## Context
P1-15 needs a production target. The owner chose Neon for Postgres and a managed container platform for the services. ADR 0004 already allows Neon. The services are stateless OCI images (api, workers, realtime, console; `infra/docker/*.Dockerfile`) built and scanned by `.github/workflows/images.yml`.

## Decision
- **Postgres: Neon.** One project per environment (production, staging); previews use Neon branches (`docs/architecture/deployment.md`). Roles `wb_migrator`, `wb_app`, `wb_worker` are created by the init SQL, never by a console login, and keep `FORCE ROW LEVEL SECURITY`.
- **Two connection kinds, because Neon's pooler is PgBouncer in transaction mode:**
  - `DATABASE_URL` (api) may use the **pooled** host. The api takes only transaction-scoped locks (`pg_advisory_xact_lock`) and sets the tenant with `set_config(..., true)` inside the transaction, which both survive transaction pooling.
  - `DATABASE_WORKER_URL` (workers, jobs) and `DATABASE_MIGRATOR_URL` **must use the direct (unpooled) host.** Jobs take session advisory locks (`pg_try_advisory_lock`: catalog import, inventory jobs, the migrator), and a session lock does not survive a pooled connection, so two replicas could both believe they hold it.
  - Neither URL may enable prepared-statement caching on a pooled connection.
- **Read replica: one Neon read-only compute on the production branch, used for reports only.** `DATABASE_READ_URL` (role `wb_app`, the replica's endpoint, pooled host is fine: reads take no session locks) feeds `deps.readPool`; `withReadTx` (`@wise-biz/db`) reads from it and falls back to the primary once when the replica is unreachable (network, shutdown, out of connections; never for a query error). Unset: everything uses the primary. Why reports only: they aggregate async rollups, so replica lag is invisible, and they are the heaviest reads. Anything a person just wrote and expects to see (a sale, a void, an export request, settings) stays on the primary to keep read-your-writes. Workers, migrations and all writes never touch the replica. Candidates for later, each only if lag is acceptable: catalog and stock list reads, audit log search.
- **Containers: any managed platform that runs an OCI image with env-var secrets, health checks, rolling deploys and a private network to Redis.** Images are pulled from GHCR by digest. No platform-specific code enters the repo; the deploy workflow is the only platform-specific file and calls the platform CLI with the image digest, then runs the one-shot `migrate` task before the new api revision takes traffic (`docs/runbooks/deploy.md`).
- **Redis:** a managed Redis with TLS on the same region (rate limits fail closed, so its availability is an api dependency).
- **Object storage:** S3-compatible (R2 or S3) for exports, receipts and backups.
- **Backups:** Neon point-in-time recovery for the database, plus the age-encrypted per-schema `pg_dump` to object storage (`infra/backup`) as the exit path off Neon. The restore drill (`docs/runbooks/restore.md`) runs against a new Neon branch.

## Consequences
- Scale-to-zero on Neon adds a cold-start delay: production keeps the compute always on; staging may scale to zero, so tests tolerate a slow first connection.
- Worker and api replicas can scale horizontally: worker jobs stay safe through session locks on the direct host.
- The single platform-specific piece (the deploy workflow) waits for the owner to name the platform. Until then, `deploy.md` is the provider-neutral procedure.
- A replica adds cost and one more URL to rotate; if reports stay fast on the primary, leave `DATABASE_READ_URL` unset.
- A move off Neon is a `pg_restore` from the backup bucket plus changing three URLs.
