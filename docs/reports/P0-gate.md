# P0 gate: Foundations

Date: 2026-10-28 · Branch: `step/p0-10` · Status: **ready for your review** (tag `v0.1.0` waits for your OK)

## Results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Fresh setup → `pnpm i && pnpm infra:up && pnpm db:migrate && pnpm check` | ⚠️ pass with one flake | `pnpm check` 2 runs: 62/77 then all but `module-infra#test`, which timed out on a container health check under parallel Docker load and passes alone (3/3). Full check ≈ 4 min 20 s warm (turbo cache partly hit); a cold clone was not timed. depcruise failure on the console `@/` alias fixed (`tsconfig.depcruise.json`). |
| 2 | P0 exit: tenant signs up, adds branch and user, every mutation audited, RLS tests pass | ✅ | Owner-journey Playwright (`E2E_FULL=1`, 1/1): sign up → Mailpit verify → sign in → create business → onboarding (business, branch) → invite → audit log shows entries. Tenancy 108/108, audit 22/22, RLS checks in `@wise-biz/db`. |
| 3 | Security review (auth, RLS, cookies, CSP, secrets, workflows) | ✅ after fixes | No HIGH. Fixed: auth-write limiter now also counts per IP (a varied cookie no longer buys a fresh bucket); all Better Auth cookies default to Secure, HttpOnly, SameSite=Strict. Open: `TRUST_PROXY_HOPS` startup guard (below). Workflows and tracked files: no secrets, no unsafe triggers. |
| 4 | Database review: RLS on every table, FK indexes | ✅ | Every tenant table has ENABLE + FORCE RLS with a policy (identity schema exempt by ADR 0010); every FK has an index. MEDIUM items scheduled below. |
| 5 | Coverage: domain ≥ 90 %, overall ≥ 80 % | ⚠️ | Domain packages: money 100 / policy 98.4 / crypto 100 / ids 100 / contracts 100 / audit-chain 100 / module-kit 93.7 lines. DB-backed module packages report 0 % because coverage is not collected from their container-backed runs; their tests pass. |
| 6 | Agent harness (AGENTS.md size, agents, commands) | ✅ | AGENTS.md is a 60-line index; 6 project agents, `/wb-step` command. Subagents stalled twice on this machine (hook latency); work continued in the main loop. |
| 7 | Dependency audit and licenses | ✅ | `pnpm audit --prod`: 3 advisories, all via the Expo dev CLI in `apps/ui-gallery`, reviewed and ignored with reasons in `pnpm-workspace.yaml`. `pnpm licenses:check`: 788 packages pass. |
| 8 | Docs match code | ✅ | PROGRESS, `docs/modules.md` (audit), `.env.example` (`POSTGRES_HOST_PORT`) updated in step commits. |
| 9 | Follow-ups closed or assigned | ✅ | Every open item in PROGRESS has an owner step. |

## Risks

- **Docker Desktop on this machine hangs under load** (twice today). The full parallel test run starts many containers; one health check timed out. CI runners are less contended, but watch for it.
- **Port 5432 conflict**: a Postgres inside Ubuntu WSL holds `127.0.0.1:5432`, so Docker silently does not publish the compose port. Workaround: `POSTGRES_HOST_PORT` plus matching `DATABASE_*_URL`.
- **A machine-wide `REDIS_URL`** points at a cloud Redis and overrides `.env` (Node `--env-file` does not replace existing variables). Local runs must override it.
- `pnpm -F api dev` restart-loops on Windows (`node --watch` fires on `node_modules`).

## Scheduled follow-ups from this gate

- [ ] Production startup fails when behind a proxy without `TRUST_PROXY_HOPS ≥ 1` (shared proxy IP makes sign-in limits global) — P1-15
- [ ] `audit.audit_log_id_seq`: revoke SELECT from `wb_app` (cross-tenant row volume) — P1 first migration step
- [ ] Idempotency rows: trigger so `wb_app` cannot rewrite a live key's response — P1 first migration step
- [ ] Tenancy write policies honour `status = 'suspended'` — P1-15
- [ ] Trigger validating `branch_ids` / `role_ids` arrays belong to the tenant (API checks today) — P1-15
- [ ] Store Better Auth session tokens hashed if supported — P1-15
- [ ] ADR addendum: `audit_log.id` bigint identity is an accepted exception to UUIDv7 (hash chain order) — P0 follow-up, docs only
- [ ] Future indexes on partitioned `audit_log`: `ON ONLY` + per-partition `CONCURRENTLY` + `ATTACH` — convention in `docs/architecture/data-model.md`
- [ ] Collect coverage for container-backed module tests — P1-01

## Decisions

- P0-11 scoped to the one Sahan package wise-biz consumes (email-kit); the rest waits until each package is used.
- Dev-only Expo CLI advisories are ignored with documented reasons rather than forcing incompatible versions.
