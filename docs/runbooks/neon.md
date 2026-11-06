# Runbook: Neon Postgres (database) setup, for beginners

Decision: ADR 0017 (Neon Postgres plus a managed container platform). This page takes you from nothing to a database that the application can use. Do the parts in order. Each part says **where** (which website or window), **what** to click or type, and **how to check** it worked.

Words used here:
- **Neon**: the company that hosts our Postgres database (neon.com).
- **Project**: your Neon account's container for one application. We use one project, called `Wise-Biz`.
- **Branch**: a copy of the database inside the project. Neon branches are cheap. We use two: `production` (real data) and `staging` (practice copy for testing). They never share data.
- **Database**: the named set of tables inside a branch. Ours is called `wise_biz`.
- **Role**: a login to the database. Neon gives you one powerful owner login. The application must use five small logins instead (part 4).
- **Compute**: the server that runs a branch. A **read replica** is a second compute that only reads, used for reports.
- **Pooled / direct connection**: two addresses to the same database. Pooled addresses contain `-pooler`. The app uses pooled; background jobs and migrations need direct (part 5).

## 1. Create the project (once)

**Where:** console.neon.tech, signed in.

1. Click **New project**.
2. **Name:** `Wise-Biz`.
3. **Postgres version:** `18` (the highest offered; the project is built and tested on 18).
4. **Region:** choose the one closest to where the application will run. The plan in `first-release.md` uses Google Cloud `asia-southeast1` (Singapore), so choose **AWS Asia Pacific (Singapore) `ap-southeast-1`**. The database and the application should sit in the same part of the world, or every request becomes slower.
5. **Database name:** `wise_biz`. **Owner role:** leave the default (`neondb_owner`).
6. **Services (the checkboxes for Neon Auth, AI Gateway, Storage, Functions, Realtime): turn all of them OFF.** wise-biz uses only Neon's Postgres. It has its own sign-in, storage, email and live updates (see ADR 0017). If your project already has them, leave them unused: do not run the "Set up this app on Neon" prompt that Neon shows (`neon init`, `neon deploy`), and do not copy their keys anywhere. In the project's **Settings**, you can remove the services you do not use, which also removes the access keys Neon created for them.
7. **Plan:** the Free plan is enough for `staging`. `production` needs a paid plan for always-on compute and read replicas; Neon tells you when a setting needs one.

**Check:** the project page opens and shows one branch (`production` or `main`) with the database `wise_biz`.

## 2. Create the two branches

**Where:** the Neon console, your project, **Branches**.

- The first branch (`production`, or `main` if Neon named it so) is your real database. If its name is `main`, rename it: open it, **Rename**, type `production`.
- Create the practice copy: **New branch**, name `staging`, **Parent branch** `production`, **Data: Current data**, then **Create**. Because production is empty, so is staging; later you never copy real customer data into staging.

**Check:** the branch list shows `production` and `staging`. Open `staging`: **Roles & Databases** lists the database `wise_biz`. (If you only see `neondb`, create `wise_biz` there with **New database**.)

## 3. Branch settings

**Where:** Branches, pick the branch, **Compute** (or the compute's **Edit** button).

| Setting | production | staging |
|---|---|---|
| Autoscaling (compute size) | min `0.5`, max `2` CU | min `0.25`, max `1` CU |
| Scale to zero (suspend when idle) | **Off** (always on, so the first sale of the morning is not slow) | On, after 5 minutes (saves money; the first request after a pause takes a second or two) |
| Read replica | Add one (**Add read replica** on the branch, part 6) | Not needed |
| IP allow-list | Leave open for now; the Cloud Run services have no fixed address | Leave open |
| Protected branch | **On** (Settings, Protection) so no one deletes it by mistake | Off |

Neon lists a setting that your plan does not include as locked; keep the default and move on.

## 4. Create the five application logins (roles)

**What this is.** Neon gave you one login, `neondb_owner`, that can do everything. The application must not use it. It uses five limited logins, one per job (the web API, the background jobs, the audit chainer, sign-in, and the migration tool), so a bug in one part cannot reach what it should not. One command creates them, once **per branch** (staging and production each get their own, with different passwords).

**Where:** your own computer, **PowerShell**, in the repository folder (the folder that contains `package.json`; `pnpm i` has been run, see `docs/GETTING-STARTED.md`).

**Start with `staging`.**

1. In the Neon console open **Connect** (button on the project dashboard). Choose **Branch** `staging`, **Database** `wise_biz`, **Role** `neondb_owner`, and **turn "Connection pooling" OFF**. Copy the connection string. It looks like `postgresql://neondb_owner:<password>@ep-xxxx.c-2.ap-southeast-1.aws.neon.tech/wise_biz?sslmode=require`. If the copied string ends in `&channel_binding=require`, delete that part. If the database in it is `neondb`, change it to `wise_biz`.
2. In the same window, find the **read replica** host only for `production` (staging has none): Connect with the replica selected; the host is between `@` and `/`. Leave it out for staging.
3. Run (put your string between the quotes):

   ```powershell
   $env:OWNER_URL = "postgresql://neondb_owner:<password>@ep-xxxx.c-2.ap-southeast-1.aws.neon.tech/wise_biz?sslmode=require"
   pnpm -F @wise-biz/db provision-neon staging
   ```

   For production, add the replica line before the last one: `$env:READ_HOST = "ep-yyyy.c-2.ap-southeast-1.aws.neon.tech"`, and use `production` as the last word. (Git Bash: `export OWNER_URL="..."` instead of `$env:OWNER_URL = "..."`.)
4. It prints `Roles created on wise_biz` and the path of a file, `C:\Users\<you>\wise-biz-staging-database-urls.txt`. The file holds the application's connection strings and passwords, one per line (`DATABASE_URL`, `DATABASE_WORKER_URL`, `DATABASE_MIGRATOR_URL`, `DATABASE_CHAINER_URL`, `DATABASE_IDENTITY_URL`, and `DATABASE_READ_URL` for production). Keep it private. You copy its lines into Secret Manager later (`first-release.md`, part 4) and then delete it.
5. If it says `Already provisioned`, the roles exist; nothing changed. If it fails, copy the error text (not the password) and ask for help.

Then close the PowerShell window, so the owner string disappears from memory.

`infra/neon/provision-roles.sql` is the same definition for people who prefer `psql`; you do not need it. Never run the dev setup (`infra/docker/postgres/init/001-roles-db.sql`): it makes the same roles with passwords equal to their names.

**Check that it worked** (new PowerShell, repository folder). Load the migrator line from the file, create the tables, run the safety check:

```powershell
$line = Get-Content "$HOME\wise-biz-staging-database-urls.txt" | Where-Object { $_ -like "DATABASE_MIGRATOR_URL=*" }
$env:DATABASE_MIGRATOR_URL = $line.Substring("DATABASE_MIGRATOR_URL=".Length)
pnpm db:migrate
pnpm db:rls-check
```

`db:migrate` lists the migrations it applied. `db:rls-check` must finish with no error. Both must pass before the first deploy.

## 5. Which connection string goes where

The script writes these for you; this table is for reference. **Pooled** (`-pooler` in the host) shares a few real connections among many clients, which suits the API. The background jobs and the migration tool take locks that last a whole session, which a pooler breaks, so they need **direct**.

| Name in Secret Manager | Role | Host | Why |
|---|---|---|---|
| `DATABASE_URL` | `wb_app` | pooled | the API's normal queries |
| `DATABASE_READ_URL` (optional) | `wb_app` | the replica's pooled host | reports only |
| `DATABASE_IDENTITY_URL` | `wb_identity` | pooled | sign-in and accounts |
| `DATABASE_WORKER_URL` | `wb_worker` | direct | background jobs (session locks) |
| `DATABASE_CHAINER_URL` | `wb_chainer` | direct | audit chain (session locks) |
| `DATABASE_MIGRATOR_URL` | `wb_migrator` | direct | creates and changes tables |

Every string ends in `sslmode=verify-full` (the production code refuses unverified connections). If a worker is pointed at a pooled host, two copies can run the same job. A quick test from a worker: `select pg_backend_pid()` twice in one session must return the same number.

## 6. The read replica (production, optional)

**Where:** Branches, `production`, **Add read replica** (needs a paid plan). Wait until it shows **Active**. Only reports read from it (ADR 0017). If it goes down the API logs `read replica unreachable; report served from the primary` and keeps working. Its settings should match the primary's (the same compute size). To switch it off, remove `DATABASE_READ_URL`.

## 7. Before the first deploy

- The part 4 check (`pnpm db:migrate`, `pnpm db:rls-check`) passed for the branch you deploy.
- You have a first backup and one restore into a new branch, timed (`docs/runbooks/restore.md`).
- For every secret you pasted anywhere by mistake (chat, a file in the repository): in Neon, the branch, **Roles & Databases**, the role, **Reset password**, then redo part 4 for that branch.

## 8. What comes next

Back to `docs/runbooks/first-release.md` (part 2 and on): Redis, object storage, email, Google Cloud, secrets, GitHub environments, then the first deploy to staging.

## Rotating passwords and previews

- Passwords are rotated as in `docs/runbooks/rotate-secrets.md`.
- Pull-request previews (optional, later): a Neon branch from `staging`, the migrations applied, the API pointed at it, the branch deleted when the pull request closes. Never copy production data into a branch.
