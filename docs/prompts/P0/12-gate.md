# P0-12 · Phase gate: Foundations

Effort: **H** · Needs: all P0 steps ✅ · Gate: report to me before tagging
Read: `docs/ROADMAP.md` (P0 exit), `SYSTEM.md` (Quality attributes), `docs/prompts/PROGRESS.md` (follow-ups)
Skills: `ecc:production-audit`, `ecc:verification-loop`, `ecc:security-review`

## Goal
Prove P0 meets its exit criteria, close or schedule every follow-up, and leave a clean base for P1.

## Checks
1. Fresh clone → `pnpm i && pnpm infra:up && pnpm db:migrate && pnpm check` green; time it.
2. P0 exit: a tenant can sign up, add a branch and a user, every mutation is audited, RLS tests pass. Demonstrate with the seed + e2e suite.
3. `/ecc:security-scan`, `ecc:security-reviewer` on the whole repo (auth, RLS, cookies, CSP, secrets, workflows).
4. `ecc:database-reviewer` on all migrations; confirm every table has RLS and every FK has an index.
5. `/ecc:test-coverage`: domain packages ≥ 90%, overall ≥ 80%.
6. `/ecc:harness-audit` for agent setup quality (AGENTS.md size, agents, commands).
7. Dependency audit and license check clean.
8. Docs: `ARCHITECTURE.md`, `docs/modules.md`, ADRs match the code (`/ecc:update-docs` for drift).
9. Follow-ups in PROGRESS.md: fix now (≤ 30 min each) or assign to a P1 step.

## Delegation
Run reviewers in parallel (`model: "sonnet"`); fixes go to the owning `wb-*` agent. One Opus subagent (`model: "opus"`) may do an independent architecture review of `modules/*` boundaries and the `runCommand` kernel.

## Output
`docs/reports/P0-gate.md`: results table (check, result, evidence link), risks, decisions. After my OK: tag `v0.1.0`.
