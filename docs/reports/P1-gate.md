# P1 gate report (draft, 2026-11-04)

Status: **not ready for go/no-go**. This file records what is verified, what is not, and what needs the owner. The gate prompt (`docs/prompts/p1/16-gate.md`) says to report before tagging; nothing is tagged.

## Verified

| Check | Result |
|---|---|
| Full `turbo run check --continue --concurrency=4` (lint, typecheck, tests with coverage gates; REDIS_URL unset) | 146 of 146 tasks green (2026-11-04, commit `1b97bfd`). Run it with that concurrency on a machine this size; unbounded parallel container starts time out. |
| Hourly rollup, reporting, workers, console | Reporting 33, workers 31, console 91 unit tests and the mocked-API Playwright reports spec pass (commit `1b35596`). |
| Dependency audit (`pnpm audit --prod`) | 13 findings before, 2 moderate after pinning `node-forge >= 1.4.1`. Left: `minimatch` (Expo tooling, build time) and `glob` (testcontainers, tests only). Both need a major bump upstream; re-check on each Renovate PR. |
| Offline drill, server half (`apps/api/test/sync-sales.test.ts`) | A day-long backlog of 120 sales, sent in uneven chunks, is applied once and in order with distinct invoice numbers; a full resend is replayed with nothing stored twice; a sale from a clock two hours ahead is refused with "The terminal clock is ahead of the server" and stores nothing (the sale stays on the terminal). Not covered: app killed mid-commit, two terminals on the last unit, 1k-sale sync lag p95 (need the POS client and a load run). |
| Tenant isolation, RLS, idempotency, audit | Covered by DB tests in every module (see PROGRESS rows). |

## Not done, and why

| Check | Blocker |
|---|---|
| 1. Full flows on Maestro and Electron | Needs devices and a built mobile and desktop app; the real-stack web flow (P1-13b) is also open. |
| 2. Offline chaos drill, client half | Kill-mid-commit, network cut mid-sale and two terminals on the last unit need the POS client on a device. |
| 3. Performance on low-end Android and mid-range Windows | Needs the physical devices. Record in `docs/reports/P1-perf.md`. |
| 4. Load (k6 on staging) | Needs a staging environment (P1-15 hosting choice). |
| 5. Security: scan, reviewers, PII scan | Dependency audit done. `ecc:security-reviewer` pass across devices, sync, payments and desktop still to run. |
| 6. Accessibility with screen readers on Android and iOS | Needs devices. Console and POS web axe checks run in CI already. |
| 7. Restore drill | Needs the hosted Postgres and object store (P1-15). |
| 8. Usability sessions | Owner runs them. Script and metric sheet ready: `docs/reports/P1-usability.md`. |

## Needs the owner

1. Hosting platform and Postgres provider (default proposed: managed container platform plus Neon).
2. Devices for the performance, accessibility and offline drills.
3. Go-ahead to push, open a PR and tag.

## Risk register (so far)

- Four DB-heavy tests are load-sensitive (api `/ready`, `sync-burst`, `wiring` hooks, workers `relay` lease). They pass alone; make them independent of container start time before CI relies on them.
- XLSX and PDF export, tax-by-rate rollups, the approvals inbox and mobile push registration are open P1-13b/13c/14 items (see PROGRESS).
- Push receipts are not read; a rejected message other than `DeviceNotRegistered` is not retried.

## Go / no-go

**No-go** until checks 1 to 8 have results.
