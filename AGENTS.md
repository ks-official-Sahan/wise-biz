# AGENTS.md

Universal, multi-tenant enterprise POS platform. Monorepo. TypeScript first; Django-ready by contract.
Keep this file short. Read linked docs only when the task touches that area.

## Read when needed

| Task touches | Read |
|---|---|
| What we build, who for, scope, phases | `PRODUCT.md`, `docs/ROADMAP.md` |
| Domain words (sale, batch, shift, tenant…) | `CONTEXT.md` |
| System map (TPS/MIS/DSS/EIS/CRM), quality targets | `SYSTEM.md` |
| Stack, repo layout, module boundaries | `ARCHITECTURE.md` |
| A specific module (owns, emits, consumes) | `docs/modules.md` |
| Tables, IDs, money, ledgers, indexes | `docs/architecture/data-model.md` |
| Offline mode, sync, conflicts | `docs/architecture/offline-sync.md` |
| Kafka, outbox, event names | `docs/architecture/events.md` |
| Auth, devices, signing, CSP/CSRF, PCI, audit | `docs/architecture/security.md` |
| MCP servers (store + platform) | `docs/architecture/mcp.md` |
| HTTP API rules, idempotency, errors | `docs/architecture/api-conventions.md` |
| Latency budgets, caching, N+1, debounce | `docs/architecture/performance.md` |
| Docker, nginx, CI/CD, Cloudflare, backups | `docs/architecture/deployment.md` |
| Payments, printers, scanners, drawers | `docs/features/payments-hardware.md` |
| Plans, trials, limits, pay-as-you-go | `docs/features/subscriptions.md` |
| UI/UX, checkout flow, ergonomics | `docs/design/ux.md` |
| Brand themes, fonts, receipts, cards | `docs/design/theming.md` |
| `@sahan-sac/*` packages, gaps, upgrades | `docs/research/sahan-packages.md` |
| Market research, competitor flaws | `docs/research/pos-market.md` |
| Why a decision was made | `docs/adr/` |
| Code style, tests, commits | `docs/CONVENTIONS.md` |

## Non-negotiables (always apply)

1. **Tenant scope everywhere.** Every row, query, cache key, event, and log carries `tenant_id`. Postgres RLS is the backstop, not the only check.
2. **IDs are UUIDv7.** Generated client-side for offline-created records. Never auto-increment, never cuid.
3. **Money is integer minor units + ISO 4217 code** (`@pos/money`). No floats. Rounding only in `@pos/money`.
4. **The checkout hot path never waits on the network.** Scan, add line, total, cash tender, and print run against local SQLite.
5. **Every mutation:** authorize first → validate (zod) → idempotency key → DB transaction → audit row + outbox event **in the same transaction**.
6. **Stock is a ledger.** Insert movements; never `UPDATE` quantities by hand. Balances are projections.
7. **Unauthorized = 404**, not 403, on admin/platform surfaces.
8. **No N+1.** Batch loads, joins, or dataloaders. Every new query path gets an index check (`EXPLAIN`).
9. **Modules talk via contracts** (`@pos/contracts`) or events. No cross-module table reads. A module must be extractable as a service.
10. **Secrets are parameters**, compared in constant time, never logged.
11. **Docs:** use Context7 for library APIs before writing code against them.
12. **Performance:** use performance optimization, best practices, latency critical system with realtime updates, use best data structures and algorithms
13. **Token Efficiency:** use caveman and ponytail skills

## Commands

```bash
pnpm i            # install
pnpm dev          # all apps via turbo
pnpm -F api dev   # one app
pnpm check        # lint + typecheck + test (must pass before commit)
pnpm db:migrate   # apply migrations
```

## Agents and cost

Use small models (Haiku 5.5/Sonnet class) for subagents with exact file paths, the acceptance check, and the doc to read. Heavy models only for architecture decisions. Details: `CLAUDE.md`.
