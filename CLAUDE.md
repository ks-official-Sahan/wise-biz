# CLAUDE.md

@AGENTS.md

Claude-specific notes. Everything shared with other agents lives in `AGENTS.md`.

## Working style

- Answers terse. Code and docs complete.
- Plan before multi-file changes: list files, the contract touched, the test that proves it.
- Prefer the smallest design that meets `SYSTEM.md` targets. Kill speculative abstraction (ponytail rule). Keep the extraction seams (contracts, events, ports) because they are planned, not speculative.
- Look up library APIs with Context7 (`resolve-library-id` → `query-docs`) before coding against them. Expo, Electron, Hono, Drizzle, Next.js, Kafka clients change fast.

## Build steps

Run one step at a time: `/wb-step docs/prompts/<phase>/<NN>-<name>.md`. Loop and rules: `.claude/commands/wb-step.md`. Order, models and effort: `docs/prompts/README.md`.

## Subagents

- Project agents in `.claude/agents/`: `wb-builder` (sonnet), `wb-db` (sonnet), `wb-ui-builder` (sonnet), `wb-tester` (haiku), `wb-scaffolder` (haiku), `wb-researcher` (haiku). Override `model` per call only when a step says so.
- Default model: Haiku or Sonnet class. Opus only for cross-module architecture review.
- Every subagent prompt includes: goal, exact paths, the one doc section to read, constraints from `AGENTS.md` non-negotiables, acceptance test command, output format (diff summary, ≤150 words).
- Split large work by module, not by layer. One subagent per module keeps context small.
- Review pass after code: `typescript-reviewer` or `react-reviewer`, `database-reviewer` for migrations, `security-reviewer` for auth, payments, devices, MCP.

## Skills to reach for

| Area | Skills |
|---|---|
| UI | impeccable, emil-design-eng, design-taste-frontend, ux-principles, mobile-design, accessibility-audit |
| Motion | gsap-greensock (web/console only), timing-mastery |
| Backend | api-design, postgres-patterns, database-migrations, kafka-stream-processing, redis-patterns |
| Quality | tdd-workflow, e2e-testing, security-review, performance-optimization |
| Storefront | seo, seo-fundamentals |

## Do not

- Do not add a dependency without checking bundle size (POS app) and license.
- Do not touch `docs/adr/*` decisions silently. New decision → new ADR.
- Do not put secrets, PII, or card data in logs, fixtures, or prompts.
