# Runbook: Neon Postgres setup

Decision: ADR 0017. Do this once per environment (production, staging).

## Create (do this once per environment)

**What this is.** Neon already gave you the database and an owner login (`neondb_owner`). The application must not use that login: it uses five limited logins (roles), one per job, so a bug in one service cannot touch what it should not. This step creates those five roles and their passwords. You do it once per Neon project, from your own computer, with one command.

**Before you start.** Keep this project as **staging** (a second Neon project later becomes production). You need the repository on your computer with `pnpm i` already run (see `docs/GETTING-STARTED.md`). The Neon "Set up this app" prompt (`neon init`, `neon deploy`) is not part of this project: do not run it.

1. In the Neon console: your project, **Dashboard**, **Connect**. Choose the branch (`production` or `main`), the database `wise_biz` and the role `neondb_owner`. Turn **Connection pooling OFF** (the host must not contain `-pooler`). Copy the connection string. If you only have the pooled string, delete `-pooler` from the host name and delete `&channel_binding=require` from the end; it then looks like `postgresql://neondb_owner:<password>@ep-xxxx.c-2.ap-southeast-1.aws.neon.tech/wise_biz?sslmode=require`.
2. Open **PowerShell** in the repository folder (the folder that contains `package.json`). Run these three lines, putting your string between the quotes (the second line is the read replica host, the part between `@` and `/` of its connection string, and may be left out):

   ```powershell
   $env:OWNER_URL = "postgresql://neondb_owner:<password>@ep-xxxx.c-2.ap-southeast-1.aws.neon.tech/wise_biz?sslmode=require"
   $env:READ_HOST = "ep-yyyy.c-2.ap-southeast-1.aws.neon.tech"
   pnpm -F @wise-biz/db provision-neon staging
   ```

   Git Bash: use `export OWNER_URL="..."` instead of `$env:OWNER_URL = "..."`. The values live only in this window; close it afterwards.
3. It prints `Roles created on wise_biz` and the path of a file, `C:Users<you>wise-biz-staging-database-urls.txt`. That file holds six lines, one connection string each (`DATABASE_URL`, `DATABASE_READ_URL`, `DATABASE_WORKER_URL`, `DATABASE_MIGRATOR_URL`, `DATABASE_CHAINER_URL`, `DATABASE_IDENTITY_URL`). These are the application logins and their passwords. Keep the file private; you copy its lines into Secret Manager later (`first-release.md`, part 4) and then delete it.
4. If it says `Already provisioned`, the roles exist already; nothing changed. If it fails with a permission error, send the error text (do not include the password).

`infra/neon/provision-roles.sql` is the same definition for people who prefer `psql` (usage in its header); you do not need it. Never run the dev init (`infra/docker/postgres/init/001-roles-db.sql`): it creates the same roles with passwords equal to their names. Passwords are rotated as in `docs/runbooks/rotate-secrets.md`.

**Check that it worked** (still in PowerShell, repository folder). Load the migrator line from the file into the variable, create the tables, and run the safety check:

```powershell
$line = Get-Content "$HOMEwise-biz-staging-database-urls.txt" | Where-Object { $_ -like "DATABASE_MIGRATOR_URL=*" }
$env:DATABASE_MIGRATOR_URL = $line.Substring("DATABASE_MIGRATOR_URL=".Length)
pnpm db:migrate
pnpm db:rls-check
```

`db:migrate` lists the migrations it applied; `db:rls-check` must finish without an error. Both must pass before the first deploy.

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
- The check above (`pnpm db:migrate`, `pnpm db:rls-check`) passed.
- Confirm `select rolbypassrls from pg_roles where rolname in ('wb_app','wb_worker')` is false for both.
- Create the first backup (`infra/backup/backup.sh`) and run one restore into a new Neon branch (`docs/runbooks/restore.md`); record the time in the drill table.

## Previews
Per PR: a Neon branch from staging, migrations applied, api pointed at it, branch deleted when the PR closes. Never copy production data into a branch.
