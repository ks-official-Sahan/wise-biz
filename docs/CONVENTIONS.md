# Conventions

## Code

- TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- ESM only. Node LTS.
- Domain code is pure: no IO, no `Date.now()` (inject `Clock`), no random (inject `Ids`).
- Use cases follow: `authorize → validate → idempotency → transaction(domain + audit + outbox) → result`.
- Errors: typed domain errors with stable `code`; mapped to RFC 9457 at the HTTP edge.
- No `any`; `unknown` + zod at boundaries.
- Files ≤ 300 lines; functions do one thing; names say what, not how.
- No barrel files inside modules (tree-shaking, cycles); packages expose explicit `exports`.
- Money via `@wise-biz/money` only; no arithmetic on raw numbers for money.
- Dates: `Temporal` (polyfill) or date-fns-tz for branch-local business dates.

## Data access

- Drizzle queries in `adapters/db` only.
- Every repository method that loads related data takes arrays (`byIds`).
- New query → index check in PR description (EXPLAIN output for large tables).
- Migrations: expand/contract, reviewed SQL committed, RLS policy for each new table.

## Frontend

- `@wise-biz/ui` components only in apps; no ad-hoc colors or sizes (tokens).
- Accessibility props required by lint (`accessibilityLabel`, roles).
- Redux for local session/cart/UI; TanStack Query for server data; no server data in Redux.
- Event handlers: debounce search (120 ms), throttle scroll/resize (rAF), guard double submit.

## Testing

| Level | Tool | Must cover |
|---|---|---|
| Unit | Vitest | Domain rules, pricing, tax, money rounding, policy |
| Property | fast-check | Pricing totals, ledger balances, sync replay idempotency |
| Integration | Vitest + Testcontainers (Postgres, Redis, Redpanda) | Use cases end to end, RLS isolation, query counts |
| Contract | OpenAPI/AsyncAPI diff + schema tests | No breaking change without version bump |
| E2E web | Playwright | Console and storefront flows, POS web |
| E2E mobile | Maestro | Sell, return, offline, shift close |
| Load | k6 | Budgets in `performance.md` |

Coverage target: domain ≥ 90%, overall ≥ 80%. Bug fix → failing test first.

## Git

- Conventional commits (`feat(sales): …`). Changesets for package releases.
- Commit scope is enforced by `commitlint.config.js` (`scope-enum`): a workspace dir name under `apps/`, `modules/`, `packages/`, `services/`, or `docs`, `ci`, `infra`, `deps`, `release`. Scope is optional. Root-level changes (`.gitignore`, root configs, lockfile) use no scope: `chore: ignore graphify-out`. Never use a file name as scope. A new workspace dir becomes a valid scope automatically.
- Small PRs (≤ 400 changed lines excluding generated). One module per PR when possible.
- PR template: what, why, contract changes, migration, perf/query notes, screenshots for UI, security notes.

## Docs

- Update `docs/modules.md` when a module's owns/emits/consumes change.
- New architectural decision → `docs/adr/NNNN-title.md` (context, decision, consequences).
- Keep `AGENTS.md` under ~80 lines; detail goes in linked docs.
