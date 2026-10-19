# P1-15 · Deploy and release pipelines

Effort: **H** · Needs: P1-12 · Gate: confirm hosting choice (ask me: container platform and Postgres provider; defaults: a managed container platform + Neon)
Read: `docs/architecture/deployment.md` (all), `docs/architecture/security.md` (Web security, Data protection)
Libraries: Docker (multi-stage, non-root), nginx, Cloudflare Workers (wrangler), EAS Build + EAS Update, electron-builder publish, GitHub Actions environments
Skills: `ecc:deployment-patterns`, `ecc:docker-patterns`, `deployment-procedures`, `ecc:security-review`

## Goal
Staging and production that a pilot can rely on: reproducible images, safe migrations, mobile and desktop releases, backups with a tested restore.

## Scope
1. Dockerfiles for `api`, `workers`, `realtime`, `console`, `storefront` (placeholder), all non-root, read-only FS, healthchecks; `infra/docker/compose.prod.yaml` for self-host with nginx.
2. `infra/nginx`: TLS, HTTP/2/3, brotli, micro-cache for public GETs only, WebSocket/SSE upgrade, rate-limit zones.
3. `apps/edge` Worker: route `/v1/*` to API origin, shortlink resolution from KV, coarse rate limiting; storefront cache rules later.
4. Workflows: `deploy.yml` (main → staging; tag → production; build → push → migrate expand → rollout → smoke → notify), `mobile.yml` (EAS Build profiles, EAS Update channels), `desktop.yml` (matrix build, publish to update feed).
5. Backups: provider PITR + nightly per-schema `pg_dump` to R2 (encrypted), restore script into staging; document the drill and measure RTO.
6. Observability wiring: OTel exporter config, Sentry DSNs per app, alert rules from deployment.md.
7. Runbooks in `docs/runbooks/`: deploy, rollback, restore, rotate secrets, revoke a device fleet.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | Chosen platform deploy API/CLI; EAS profiles; wrangler routes + KV |
| 2 | wb-scaffolder (haiku) | Dockerfiles, compose.prod, nginx config | Items 1–2 |
| 3 | wb-builder (sonnet) | `apps/edge/**`, backup/restore scripts | Items 3, 5 |
| 4 | wb-scaffolder (haiku) | `.github/workflows/{deploy,mobile,desktop}.yml` | Item 4 |
| 5 | orchestrator | runbooks, observability config | Items 6–7 |

## Acceptance
- Staging deploy from `main` succeeds end to end; smoke tests pass against staging URLs.
- Restore drill: nightly dump restored into a fresh staging DB; RTO recorded in the runbook.
- Images scan clean (Trivy) of HIGH/CRITICAL; containers run as non-root.
- Android internal build and desktop builds downloadable from CI artifacts.

## Review
`ecc:security-reviewer`, `ecc:production-audit` skill checklist
