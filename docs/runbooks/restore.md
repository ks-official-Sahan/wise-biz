# Runbook: backups and restore

## What exists
| Layer | What | Retention |
|---|---|---|
| Provider PITR | continuous WAL, any second | at least 7 days |
| Nightly logical | `infra/backup/backup.sh`: one `pg_dump -Fc` per schema, `age`-encrypted, uploaded to the S3/R2 bucket | 35 days; the first of each month kept 1 year (bucket lifecycle rule) |
| Per-tenant export | on demand, from the console/API | n/a |

The backup role needs `BYPASSRLS` (all tables use `FORCE ROW LEVEL SECURITY`; `pg_dump` fails without it). Create a dedicated `wb_backup` role used by this job only. The `age` **private** key is kept offline (two holders); the host has the public key only.

Schedule (cron or a platform job): `0 2 * * * infra/backup/backup.sh`. Alert if no new `<stamp>/` prefix appears in 26 hours.

## Restore into a fresh database
1. Provision an empty Postgres 18 with `pgvector`. Create the roles (`wb_migrator`, `wb_app`, `wb_worker`, `wb_chainer`, `wb_identity`) with real passwords and the same attributes as `infra/docker/postgres/init/001-roles-db.sql` (`NOBYPASSRLS`, connection limits, timeouts). Never run the dev init file against production: it uses placeholder passwords.
2. `BACKUP_BUCKET=... BACKUP_AGE_IDENTITY=/secure/age.key infra/backup/restore.sh <stamp> <admin-database-url>`
3. The script refuses a non-empty target, recreates extensions, restores every schema, then prints table and forced-RLS counts. Compare the RLS count with production (`select count(*) from pg_class where relforcerowsecurity`).
4. Run `pnpm db:migrate` against the restored database: it must report nothing to apply for the same release.
5. Point a staging API at it and sign in; run `pnpm db:rls-check`.

## Drill (quarterly)
Run the steps above into staging. Record the wall-clock time the script prints as the **measured RTO** in the table below, and any step that needed a human.

| Date | Backup stamp | RTO (script) | Notes |
|---|---|---|---|
| _not yet drilled_ | | | The scripts are written and syntax-checked; the first real drill needs the bucket, `age` and a staging database (P1-15 acceptance). |
