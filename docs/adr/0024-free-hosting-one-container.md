# 0024. A free hosting path: one container for the API and the workers, the console on a static-friendly host

Status: accepted
Date: 2026-11-06

## Context

ADR 0017 chose Neon plus a managed container platform, and `deploy.yml` targets Google Cloud Run. The owner cannot create a
Google Cloud billing account (error `OR_BACR2_59`, every card refused) and will not pay for anything until the product earns
money. Cloud Run would not have been free anyway: its free allowance (about 50 vCPU-hours a month) does not cover the workers
and realtime services, which run all the time.

Free container hosts (Render, Koyeb) sleep after idle and offer one always-on-capable service, with 512 MB of memory.

## Decision

1. A new app, `apps/server`, starts the API and the workers in one Node process (`startAll`: API first, workers next; if the
   workers cannot start, the API is closed and the error is rethrown; stopping stops both and reports a failure of either).
   The existing three-service layout stays for Cloud Run.
2. The realtime service is not part of it. A free host exposes one port, and terminals already poll as a fallback (ADR 0015).
3. The image recipe is the same (`infra/docker/service.Dockerfile`, `APP=server`). `render.yaml` describes the one free Render
   service and lists every variable as a dashboard value, never a value in the file.
4. The console runs on Vercel Hobby (its normal Next.js host, free, no card), with `API_ORIGIN` pointing at the server; the
   console already proxies `/v1` (`apps/console/src/proxy.ts`).
5. A workflow, `keepalive.yml`, requests `/health` every 10 minutes when the repository variable `SERVER_URL` is set, so the
   server does not sleep and the workers keep running.
6. Database migrations are run by the owner from a PC before a release (`pnpm db:migrate`); a free host has no release step.
7. Desktop builds can ship unsigned when the environment variable `DESKTOP_UNSIGNED=true` is set: Windows and Linux only (macOS
   is skipped). This is an explicit owner switch, and the build prints a warning. It is not a default.

## Consequences

- Cost zero. The first request after a sleep is slow if the pinger fails; background work pauses while the server sleeps.
- One process means a crash or a memory limit (512 MB) takes the API and the workers down together. The runbook says what to
  lower (`DATABASE_POOL_MAX`) and when the free path is too small.
- No live push to terminals or the console: they poll. The latency of "a sale appears in the console" is a poll interval.
- Unsigned Windows installers show a SmartScreen warning, and an auto-update feed has no signature to check. The runbook says
  not to auto-update from a host the owner does not control. Signing certificates (or Azure Trusted Signing) come later.
- Moving to Cloud Run or a paid server later changes the hosting and the deploy workflow only; the code and the image recipe
  are the same.

## Alternatives not taken

- **Fly.io, Railway, Koyeb:** need a card or are a trial. Koyeb's free tier allows one service; sources disagree on the card.
- **Oracle Cloud Always Free:** a real always-on VM, but account sign-up also verifies a card and often refuses them.
- **Cloudflare Containers:** needs the paid Workers plan.
- **A paid VPS (for example Hostinger):** always on, a few dollars a month, one `docker compose` for everything including the
  realtime service. The right next step once there is revenue.
