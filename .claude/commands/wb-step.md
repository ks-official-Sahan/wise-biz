---
description: Run one wise-biz build step (docs/prompts/...) with the plan → delegate → verify → commit loop
argument-hint: <step file, e.g. docs/prompts/P0/01-monorepo.md>
---

Run the build step in `$ARGUMENTS`.

You are the orchestrator: lead architect and integrator. Subagents do the bulk of the work. You plan, delegate, integrate, verify, and keep the main context small.

## Protocol

1. **Load context, cheapest first.** AGENTS.md is already loaded. Read `docs/prompts/PROGRESS.md` and the step file. If any step listed in `Needs:` is not ✅ in PROGRESS.md, stop and name it.
2. **Read only what the step lists** under `Read:`. For every library under `Libraries:`, send the `wb-researcher` subagent to Context7 and ask for version-specific API notes (≤ 200 words per library, with links). Do not pull whole docs into the main context.
3. **Plan** in ≤ 40 lines: files to create or change, contracts and events touched, tests that prove the step, and the subagent split with **disjoint file ownership**. Create tasks with TaskCreate. If the step says `Gate: confirm plan` (or another gate), show the plan or the decision and wait for me.
4. **Branch:** `git switch -c step/<step-id>` from up-to-date `main`.
5. **Delegate** using the step's Delegation table. Every subagent prompt contains:
   - goal and the exact paths it owns (and must not touch anything else);
   - the doc section(s) to read;
   - the AGENTS.md non-negotiables that apply;
   - the acceptance command it must run;
   - reply format: "≤ 150 words: files changed, commands run + results, open issues".
   Pass `model` from the table. Run agents in parallel only when their paths do not overlap; give parallel agents that install or build `isolation: "worktree"`.
6. **Integrate** yourself: wiring, exports, cross-module glue. Keep these edits small.
7. **Verify:** run every Acceptance command. Fix until green, delegating each fix to the agent that owns the path. Two failed attempts on the same error → stop and report with evidence.
8. **Review:** run the reviewers listed under `Review:` on `git diff main...HEAD`, passing `model: "sonnet"`. Fix CRITICAL and HIGH findings. Record MEDIUM ones as follow-ups in PROGRESS.md.
9. **Docs:** update the docs the step names; a new architectural decision → new ADR in `docs/adr/`. Keep AGENTS.md ≤ 80 lines.
10. **Record:** mark the step ✅ in PROGRESS.md with date, commit hash, deviations, and follow-ups.
11. **Commit** with Conventional Commits (`feat(scope): …`). Do not push or open a PR unless I ask.
12. **Report** in ≤ 10 lines: what works now, how to run it, follow-ups, next step.

## Hard rules

- Never weaken a test, RLS policy, auth check, or lint rule to make something pass.
- No new dependency without a Context7 check, an acceptable license, and a size note (for `apps/pos` and `apps/desktop`).
- Stay inside the step's scope. Note anything outside it as a follow-up.
- If the plan exceeds ~1,500 changed lines (excluding generated files and lockfiles), stop after planning and propose a split.
- Prefer the simplest design that meets `SYSTEM.md` targets (ponytail). Keep the planned seams: contracts, ports, events.
- Answers to me are terse (caveman). Code, tests and docs are complete.
