# Runbook: Neon Postgres setup

Decision: ADR 0017. Do this once per environment (production, staging).

## Create
1. Create a Neon project in the region closest to the container platform. Postgres 18. Keep compute always on in production (staging may scale to zero).
2. Create the database `wise_biz` (Neon console, Databases, New database) and a read replica for the production branch (Branches, the branch, Add read replica).
3. Create the service roles with the script, not by hand. In the Neon console open Connect, pick the branch, the database `wise_biz` and the owner role, turn **Connection pooling off** (the script needs the direct host) and copy the string. Then, from the repository root (PowerShell):

   ```powershell
   $env:OWNER_URL = "<the string you copied>"
   $env:READ_HOST = "<the read replica host, from Connect with the replica selected>"   # optional
   pnpm -F @wise-biz/db provision-neon staging      # or: production
   ```

   (Git Bash: `export OWNER_URL="..."` instead of `$env:OWNER_URL = "..."`.) It creates the five roles with random passwords, hands the database to `wb_migrator`, writes the five connection strings (and `DATABASE_READ_URL` when you gave `READ_HOST`) to `~/wise-biz-<env>-database-urls.txt` outside the repository, and prints no password. It refuses to run twice. Put each line into Secret Manager as `wb-<env>-<NAME>` and delete the file. `infra/neon/provision-roles.sql` is the same definition for people who prefer `psql` (usage in its header). Never run the dev init (`infra/docker/postgres/init/001-roles-db.sql`): it creates the same roles with passwords equal to their names.
4. Passwords are rotated as in `docs/runbooks/rotate-secrets.md`.

## Connection strings (the part that goes wrong)
| Env var | Role | Host |
|---|---|---|
| `DATABASE_URL` | `wb_app` | **pooled** (`-pooler` host); `sslmode=verify-full` (production pools refuse unverified TLS) |
| `DATABASE_READ_URL` (optional) | `wb_app` | **read replica** endpoint, pooled host; `sslmode=verify-full` |
| `DATABASE_WORKER_URL` | `wb_worker` | **direct** host; `sslmode=verify-full` (production pools refuse unverified TLS) |
| `DATABASE_MIGRATOR_URL` | `wb_migrator` | **direct** host; `sslmode=verify-full` (production pools refuse unverified TLS) |

Why: workers and the migrator use session advisory locks, which do not survive Neon's transaction-mode pooler. If a worker is pointed at the pooled host, two replicas can run the same job. A quick check from a worker pod: `select pg_backend_pid()` twice in one session must return the same pid.

## Read replica (optional)
Add one read-only compute to the production branch (Console, `neon branches add-compute <branch> --type read_only`, or the API). Copy its connection string for role `wb_app` into `DATABASE_READ_URL`. Only reports read from it (ADR 0017); if it goes down the api logs `read replica unreachable; report served from the primary` and keeps serving. Check that `max_connections` and `max_locks_per_transaction` match the primary. Remove the variable to turn it off.

## Before the first deploy
- `pnpm db:migrate` against the direct migrator URL; then `pnpm db:rls-check`.
- Confirm `select rolbypassrls from pg_roles where rolname in ('wb_app','wb_worker')` is false for both.
- Create the first backup (`infra/backup/backup.sh`) and run one restore into a new Neon branch (`docs/runbooks/restore.md`); record the time in the drill table.

## Previews
Per PR: a Neon branch from staging, migrations applied, api pointed at it, branch deleted when the PR closes. Never copy production data into a branch.
