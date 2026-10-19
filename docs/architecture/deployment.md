# Deployment, CI/CD, operations

## Environments

| Env | Purpose | Data |
|---|---|---|
| local | `docker compose up`: Postgres 18, Redis, Redpanda, MinIO, Mailpit, nginx | Seeds |
| preview | Per PR: console/storefront preview, API on ephemeral DB branch (Neon branching) | Seeds |
| staging | Production-like; load tests; mobile internal builds | Anonymized snapshot |
| production | Multi-AZ region; second region warm standby (P2) | Real |

## Containers

- One Dockerfile per app, multi-stage, `node:<lts>-slim` base, non-root user, read-only FS, healthcheck endpoint `/health` (liveness) and `/ready` (DB + Redis + broker).
- `infra/docker/compose.yaml` for dev; `infra/k8s/` (Helm) when moving beyond a few nodes. Start on a container platform (Fly/Render/ECS/DigitalOcean App Platform) — no Kubernetes until needed.

## Local setup

```bash
cp .env.example .env      # dev values match compose; never reuse them anywhere else
pnpm infra:up             # postgres, redis, rustfs (S3), mailpit; pnpm infra:up:kafka adds redpanda
pnpm env:check            # .env.example matches the code schemas (@wise-biz/env)
pnpm db:psql              # psql as wb_app (RLS applies; NOBYPASSRLS)
```

| Service | Host port | Notes |
|---|---|---|
| Postgres 18 + pgvector | 5432 | DB `wise_biz`; roles `wb_migrator` (owns schemas, runs migrations), `wb_app` (runtime, `NOSUPERUSER NOBYPASSRLS`); extensions `pgcrypto`, `pg_trgm`, `vector`, `pg_stat_statements` |
| Redis 8 | 6379 | |
| Redpanda | 19092 (Kafka) | Profile `kafka`; Console on 8080 |
| RustFS (S3-compatible) | 9000 (S3), 9001 (console) | Bucket `wise-biz` created by one-shot `storage-init` (aws-cli). MinIO images are no longer published; any S3 API works |
| Mailpit | 1025 (SMTP), 8025 (UI) | All local mail lands here |

`pnpm infra:down` stops containers and keeps data; `pnpm infra:reset` asks for confirmation, then deletes volumes so `infra/docker/postgres/init/*.sql` runs again (init SQL runs only on an empty volume). Apps read env only through `@wise-biz/env` (`defineEnv`), which fails fast naming invalid keys, never values; production also runs `assertProductionEnv()`.

## nginx

- TLS termination (self-host), HTTP/2 + HTTP/3, gzip/brotli.
- `proxy_cache` micro-cache for public GETs (storefront JSON, catalog images) 1–5 s, `proxy_cache_lock on`, `stale-while-revalidate`.
- Never cache authenticated responses (`Cache-Control: private, no-store` from API).
- Rate limit zones as a second line after the edge.
- WebSocket upgrade for `apps/realtime`.

## Cloudflare

- DNS, WAF, bot management, DDoS.
- `apps/edge` Worker: route by path (`/v1/*` → API origin, future `/v1/insights/*` → Django), pre-verify device signatures, coarse rate limiting (KV/Durable Objects), shortlinks (`/s/:code` from KV), storefront edge cache with tag purge.
- R2 for media and backups (via media-kit).
- Cloudflare Access + Tunnel in front of the platform console and platform MCP.
- Workers-compatible modules (pure Hono + `@wise-biz/contracts`) can run at edge later; the transactional core stays in-region near Postgres.

## CI (GitHub Actions)

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yml` | PR | install (pnpm cache) → turbo affected: lint, typecheck, unit tests, contract tests, dependency-cruiser boundaries, migration check on fresh DB (schema diff = 0), package tarball verify (Sahan `verify:packages`) |
| `security.yml` | PR + nightly | `pnpm audit`, CodeQL, gitleaks, Trivy image scan, license check |
| `e2e.yml` | PR (affected apps) | Playwright (console, storefront, POS web), API integration tests with compose services |
| `mobile.yml` | main + tags | EAS Build (Android AAB/APK, iOS), EAS Update channels (`staging`, `production`) for JS-only fixes; Maestro smoke on device farm |
| `desktop.yml` | tags | electron-builder: Windows (NSIS, signed), macOS (dmg, notarized), Linux (AppImage, deb); auto-update feed |
| `deploy.yml` | main → staging; tag → production | build images → push → migrate (expand) → blue/green or rolling → smoke → migrate (contract, later release) |
| `load.yml` | nightly | k6 against staging, budget check |

Branch protection: required checks, 1 review, signed commits for release tags. Conventional commits → changesets for package versions.

### Branch protection checklist (`master`)

Set in GitHub → Settings → Rules → Rulesets (target: default branch):

- [ ] Require a pull request; 1 approving review; dismiss stale approvals on push; CODEOWNERS review required.
- [ ] Required status checks (strict, branch up to date): `CI / check`, `CI / actionlint`, `Security / audit`, `Security / gitleaks`, `Security / codeql`, `Security / licenses`, `Security / dependency-review`.
- [ ] Require linear history (squash or rebase merge only; disable merge commits).
- [ ] Block force pushes and deletion; no bypass list except the release bot.
- [ ] Require signed commits on release tags (tag ruleset `v*`).
- [ ] Actions settings: default `GITHUB_TOKEN` read-only; "Allow actions created by GitHub" + SHA-pinned third-party only; fork PR workflows need approval.

Workflows pin every third-party action to a commit SHA (Renovate `helpers:pinGitHubActionDigests` keeps them current). No workflow uses `pull_request_target`.

## Database operations

- Migrations: expand/contract only. Never drop or rename in the same release that stops using a column.
- Backups: provider PITR (≥ 7 days) + nightly `pg_dump` per schema to R2 (encrypted, 35-day retention, monthly kept 1 year) + per-tenant export on demand (ZIP of NDJSON/CSV + media manifest).
- Restore drill quarterly into staging; document RTO achieved.
- Tenant-level restore: from per-tenant export or from platform MCP snapshots for small scopes.

## Releases and flags

- Feature flags per tenant/branch/plan (`@wise-biz/entitlements` reads flags + plan). Kill switches for integrations and MCP writes.
- Mobile: store releases for native changes; OTA (EAS Update) for JS within the same runtime version; minimum version gate via `426`.
- Desktop: staged rollout (10% → 50% → 100%) through update channels.

## Observability

- OpenTelemetry SDK in API, workers, realtime; trace context propagated through Kafka headers.
- Logs JSON with `requestId`, `tenantId`, `deviceId`, never PII/secrets.
- Metrics: RED per route, outbox lag, consumer lag, sync queue depth per tenant, device online ratio, p95 checkout timings reported by devices.
- Alerts: SLO burn rate, outbox lag > 60 s, DLQ growth, device fleet offline spikes, auth failure spikes.
- Client errors: Sentry (POS, desktop, console, storefront) with PII scrubbing.
