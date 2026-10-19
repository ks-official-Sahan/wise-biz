# P0-03 · CI and security workflows

Effort: **M** · Needs: P0-01 · Gate: none
Read: `docs/architecture/deployment.md` (CI table)
Libraries: GitHub Actions (setup-node, pnpm/action-setup, cache), Turborepo remote/local cache in CI, CodeQL, gitleaks, Renovate, actionlint
Skills: `ecc:github-ops`, `ecc:deployment-patterns`

## Goal
Every PR runs fast, affected-only checks plus security scans; dependency updates arrive as grouped PRs.

## Scope
1. `.github/workflows/ci.yml`: on PR and push to `main`; concurrency cancel-in-progress; pnpm store + turbo cache; `pnpm check --filter=...[origin/main]` on PRs, full on `main`; job summary with turbo timings. Services (Postgres/Redis) added later when integration tests exist; leave a commented job template.
2. `.github/workflows/security.yml`: PR + nightly: `pnpm audit --prod --audit-level=high`, gitleaks, CodeQL (javascript-typescript), license allowlist check (MIT, Apache-2.0, BSD, ISC, MPL-2.0; flag others).
3. `.github/workflows/actionlint.yml` or run actionlint inside ci.yml.
4. `renovate.json`: weekly schedule, group by ecosystem (expo, react, eslint, types), automerge patch for devDependencies only, pin GitHub Actions by SHA.
5. `.github/pull_request_template.md` (what, why, contracts, migration, perf/query notes, screenshots, security notes), `CODEOWNERS` (placeholder owner), `.github/ISSUE_TEMPLATE/` (bug, feature).
6. `docs/architecture/deployment.md`: branch protection checklist (required checks, 1 review, linear history).

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | Current action versions + pnpm/turbo caching recipe |
| 2 | wb-scaffolder (haiku) | `.github/**`, `renovate.json` | Items 1–5 |
| 3 | orchestrator | docs | Item 6, review YAML |

## Acceptance
- `actionlint` passes locally (install via `go install` or Docker image).
- Push branch → CI and security workflows green (ask me to push if you cannot).
- All third-party actions pinned to a commit SHA with a version comment.

## Review
`ecc:security-reviewer` (workflow permissions: least privilege, no `pull_request_target` with checkout of PR code)
