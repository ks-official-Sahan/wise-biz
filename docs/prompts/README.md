# Build prompts

wise-biz is built through numbered **steps**. Each step is one PR-sized slice (about ½–2 days of agent work) with a goal, scope, delegation plan, and acceptance checks. One reusable command runs every step the same way.

```
You ──/wb-step <step file>──► Orchestrator (main session, Opus)
                                 │ plan · split · integrate · verify · review · commit
                                 ├─► wb-researcher  (haiku)  Context7 notes
                                 ├─► wb-scaffolder  (haiku)  config, boilerplate
                                 ├─► wb-builder     (sonnet) domain, use cases, packages
                                 ├─► wb-db          (sonnet) migrations, RLS, queries
                                 ├─► wb-ui-builder  (sonnet) screens, components
                                 ├─► wb-tester      (haiku)  tests from spec
                                 └─► ecc reviewers  (sonnet) typescript / react / database / security / a11y
```

## How to run a step

In Claude Code, inside the repo:

```
/wb-step docs/prompts/P0/01-monorepo.md
```

Without the slash command (other harnesses), paste:

```
Follow .claude/commands/wb-step.md exactly for the step file docs/prompts/P0/01-monorepo.md.
```

After each step: review the diff, push, open a PR (or ask the session to), merge, then `/clear` and start the next step. `PROGRESS.md` carries state between sessions, so a fresh session costs very little context.

## Models and effort

**Keep Opus 5.5 as the orchestrator.** Planning, splitting work across agents, integrating, and judging reviews are where mistakes compound; that is where the strongest model pays for itself. The bulk of the tokens go to subagents, which run on Sonnet and Haiku.

| Role | Model | Effort |
|---|---|---|
| Main session, steps marked **H** (architecture, money, sync, security, devices, payments, MCP, phase gates) | Opus 5.5 | High |
| Main session, steps marked **M** (CRUD modules, console screens, config, reports) | Opus 5.5 | Medium |
| Domain logic, adapters, migrations, UI | Sonnet (`wb-builder`, `wb-db`, `wb-ui-builder`) | medium |
| Config, boilerplate, tests from a clear spec, docs, research | Haiku (`wb-scaffolder`, `wb-tester`, `wb-researcher`) | low–medium |
| Reviews | ecc reviewers with `model: "sonnet"` | default |
| Second opinion on a risky design (sync, signing, ledger) | Opus subagent, once per phase at most | High |

Guidance:
- Do not use Max/xhigh effort by default. Raise it only to debug a stubborn concurrency or sync bug.
- Do not run the orchestrator on Haiku. A Sonnet orchestrator is acceptable for **M** steps in P2 and later if budget is tight.
- If a Haiku agent fails the same task twice, the orchestrator re-delegates it to Sonnet rather than retrying.
- The Agent tool's `haiku` and `sonnet` aliases resolve to the current versions. Your preference for older 4.5/4.6 models only applies if your harness lets you pin them.

## Token hygiene

- One step per session; `/clear` after the commit. If a step must span sessions, use `/ecc:save-session` and `/ecc:resume-session`.
- `/compact` when context passes ~50% mid-step.
- Library docs go through `wb-researcher` (short notes), never full pages into the main session.
- Subagents reply in ≤ 150 words; the orchestrator reads diffs, not narratives.
- The AGENTS.md read table means agents open only the doc a task needs.

## ECC and skills by moment

| Moment | Use |
|---|---|
| Unclear requirement before a step | `/ecc:plan-prd` or the `mattpocock-skills:grilling` skill |
| Each step | `/wb-step` (built-in plan, delegation, and review loop) |
| Backend design | skills `ecc:hexagonal-architecture`, `ecc:api-design`, `ecc:postgres-patterns`, `ecc:database-migrations`, `ecc:backend-patterns` |
| Performance | `ecc:latency-critical-systems`, `performance-optimization`, `ecc:performance-optimizer` agent |
| UI | `impeccable`, `emil-design-eng`, `design-taste-frontend`, `ux-principles`, `mobile-design`, `vercel-react-native-skills`, `accessibility-audit` |
| Bug | `/ecc:orch-fix-defect` or `mattpocock-skills:diagnosing-bugs` |
| Refactor | `/ecc:orch-refine-code` |
| PR review | `/ecc:code-review` (checklist) or `/ecc:orch-review` (deep) |
| Phase gate | `/ecc:security-scan`, `/ecc:harness-audit`, `/ecc:test-coverage`, `ecc:production-audit` skill |
| Build broken | `/ecc:build-fix`, `/ecc:react-build` |
| Docs drift | `/ecc:update-docs` |

## Step order

**H** = Opus High, **M** = Opus Medium. Steps in the same "Track" column with all `Needs` done can run in parallel sessions on separate branches or worktrees.

### P0 — Foundations

| Step | Title | Effort | Needs | Track |
|---|---|---|---|---|
| [P0-01](P0/01-monorepo.md) | Monorepo, tooling, boundaries | M | — | — |
| [P0-02](P0/02-local-infra-env.md) | Local infra (compose) + env schema | M | P0-01 | A |
| [P0-03](P0/03-ci-baseline.md) | CI and security workflows | M | P0-01 | B |
| [P0-04](P0/04-core-packages.md) | ids, money, errors, contracts | H | P0-01 | A |
| [P0-05](P0/05-crypto-policy-audit-chain.md) | crypto, policy, audit-chain | H | P0-04 | A |
| [P0-06](P0/06-api-db-rls.md) | API skeleton, DB, RLS | H | P0-02, P0-04 | A |
| [P0-07](P0/07-outbox-idempotency-audit.md) | Outbox, events, idempotency, audit | H | P0-05, P0-06 | A |
| [P0-08](P0/08-identity-tenancy.md) | Identity + tenancy | H | P0-07 | A |
| [P0-09](P0/09-design-system.md) | Theme + UI foundation | H | P0-04 | B |
| [P0-10](P0/10-console-shell.md) | Console shell | M | P0-08, P0-09 | A |
| [P0-11](P0/11-upstream-sahan-packages.md) | Upstream `@sahan-sac` upgrades (Sahan repo) | M | P0-08 | C |
| [P0-12](P0/12-gate.md) | P0 gate | H | all P0 | — |

### P1 — Sell and stock, offline

| Step | Title | Effort | Needs | Track |
|---|---|---|---|---|
| [P1-01](P1/01-devices.md) | Devices, signing, PIN | H | P0-12 | A |
| [P1-02](P1/02-catalog-search.md) | Catalog + search + import | M | P0-12 | B |
| [P1-03](P1/03-pricing-tax.md) | Pricing and tax engine | H | P1-02 | B |
| [P1-04](P1/04-inventory.md) | Inventory ledger, batches, FEFO | H | P1-02 | C |
| [P1-05](P1/05-sales-server.md) | Sales, returns, shifts (server) | H | P1-01, P1-03, P1-04 | A |
| [P1-06](P1/06-sync-server-realtime.md) | Sync server + realtime | H | P1-05 | A |
| [P1-07](P1/07-sync-client.md) | `@wise-biz/sync` client + local DB | H | P1-06 | A |
| [P1-08](P1/08-pos-app-shell.md) | POS app shell (Expo) | M | P1-01, P0-09 | B |
| [P1-09](P1/09-sell-screen.md) | Sell screen | H | P1-07, P1-08 | A |
| [P1-10](P1/10-tender-receipts-hardware.md) | Tender, receipts, hardware ports | H | P1-09 | A |
| [P1-11](P1/11-returns-shifts-ui.md) | Returns, voids, shifts, overrides UI | M | P1-10 | A |
| [P1-12](P1/12-desktop-electron.md) | Desktop (Electron) + hardware bridge | H | P1-10 | B |
| [P1-13a](P1/13a-console-catalog-stock.md) | Console: catalog and stock | M | P1-04 | C |
| [P1-13b](P1/13b-console-sales-devices.md) | Console: sales, reports, devices | M | P1-06 | C |
| [P1-13c](P1/13c-console-branding.md) | Console: theme, receipt, letterhead editors | M | P1-10 | C |
| [P1-14](P1/14-reporting-notifications.md) | Rollups, exports, notifications | M | P1-06 | B |
| [P1-15](P1/15-deploy-release.md) | Deploy and release pipelines | H | P1-12 | B |
| [P1-16](P1/16-gate.md) | P1 gate + pilot readiness | H | all P1 | — |

### P2 — Enterprise

See [P2/README.md](P2/README.md). Steps there are shorter because the P0–P1 patterns already exist. The orchestrator expands each one in its planning phase.

### P3 and later

Generate with [NEXT-PHASE.md](NEXT-PHASE.md) at the P2 gate, using what was learned.

## Writing new steps

Use the template in [NEXT-PHASE.md](NEXT-PHASE.md). Keep steps PR-sized, list exact docs to read, give each subagent disjoint paths, and make every acceptance check a runnable command or an observable behavior.
