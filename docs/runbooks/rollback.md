# Runbook: rollback

## Code only (the migration was expand-only, which is the rule)
1. `WB_VERSION=<previous> docker compose -f infra/docker/compose.prod.yaml --env-file .env.prod up -d --no-deps api workers realtime console`
2. Confirm `/v1/ready` is 200 and workers are consuming (`relay_lag_ms` falling).
The new columns and tables stay; the old code ignores them. This is why migrations are expand-only.

## A migration itself failed
`migrate` exits non-zero and the services do not start, so production is still on the old code. Read `docker compose logs migrate`. Migrations are transactional per file: the failed file left nothing behind. Fix forward in a new migration (never edit a shipped one) and release again.

## Data damage (bad deploy wrote wrong data)
Do not roll the database back. Stop the writer (scale `api` and `workers` to 0), then use `restore.md` to restore into a **new** database and compare; recover rows with a reviewed script. Point-in-time recovery from the provider is the fast path for "undo the last hour".

## Terminals
Offline terminals keep selling from local SQLite and sync when the API returns. A rollback never needs a terminal action unless a release changed the sync contract (then ship a compatible API first).
