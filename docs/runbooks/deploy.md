# Runbook: deploy

Applies to the self-hosted stack (`infra/docker/compose.prod.yaml`). Managed container platforms follow the same order; only the rollout command differs.

## Rules
- Migrations are **expand-only** while old code still runs: add columns/tables/indexes, never drop or rename in the same release. Contract (drop) steps ship one release later (`docs/CONVENTIONS.md`).
- Never deploy on a failing `pnpm check`. Tag = release: `vX.Y.Z` on a green `main`.
- Secrets live in `.env.prod` (or the platform's secret store). Never in the image, the repo or a log.

## Steps
1. `git fetch --tags && git checkout vX.Y.Z`
2. Split the secrets per service (least privilege: the console gets no database or auth secret, realtime no mail or storage keys): `node scripts/split-env-prod.mts .env.prod`. Run it again whenever `.env.prod` changes; it prints the names of variables no service reads.
   Build: `WB_VERSION=X.Y.Z docker compose -f infra/docker/compose.prod.yaml --env-file .env.prod build`
3. Scan: `trivy image --severity HIGH,CRITICAL --exit-code 1 wise-biz/api:X.Y.Z` (and workers, realtime, console). Fix or document an exception before continuing.
4. Take a pre-release backup: `infra/backup/backup.sh` (see `restore.md`).
5. Migrate and roll: `WB_VERSION=X.Y.Z docker compose ... up -d`. The `migrate` service runs first; the services start only if it exits 0.
6. Smoke: `curl -fsS https://<host>/v1/ready` returns 200; sign in to the console; open Reports; check `docker compose logs --since 5m workers` for `consumer dead-lettered` or `relay_error`.
7. Watch for 15 minutes: error rate, p95 latency, relay lag (`relay_lag_ms`), oldest unchained audit age.

## If step 5 or 6 fails
Follow `rollback.md`. Do not "fix forward" a failed migration under pressure.
