# Module governance

How module boundaries are kept. Each row names its mechanism; rows marked "review" or "convention" are checked by people, not by a tool. Add a module by copying `modules/_template` and registering it in `modules/registry.json`.

| Rule | Enforced by | When |
|---|---|---|
| A module is registered (name, schema, global or tenant-scoped) | `modules/registry.json`, read by the migrator (`packages/db/src/registry.ts`) and the API module loader (`apps/api/src/modules.ts`) | `pnpm db:migrate`, API start |
| No imports across module internals, apps, adapters, infra, Node I/O from domain code; no cycles | `pnpm depcruise` (`.dependency-cruiser.cjs`) | CI |
| Modules talk through contracts (`@wise-biz/contracts`), ports injected at the composition root (`apps/api/src/*-ports.ts`) or events | code review plus depcruise | every PR |
| Every tenant table has forced RLS with a tenant policy; global schemas (identity) give the runtime roles no privilege | `pnpm db:rls-check` | CI |
| Append-only tables revoke UPDATE/DELETE from the runtime role in their migration | convention plus database review (`rls-check` does not test it; open follow-up P0-06a) | every migration |
| Every mutation: authorize, validate (zod), idempotency key, one transaction with audit row and outbox event | `runCommand` in `@wise-biz/module-kit` is the mechanism; using it is a review check | every mutation |
| Events are named `module.entity.past_tense`, versioned, and registered once (duplicate or malformed definitions throw) | `defineEvent` in `@wise-biz/contracts` | module load |
| Changes within an event version are additive only | convention, review | every PR |
| Licences on the allowlist, no known HIGH advisories, no secrets | `pnpm licenses:check`, `pnpm audit`, gitleaks | CI |
| New decision, new ADR; accepted ADRs are not edited silently | `docs/adr/`, `CLAUDE.md` | every PR |
| Commit scopes and subject style | commitlint, lefthook | commit |

## Extraction readiness (a module must be movable to a service)

A module is extractable when: its schema is its own, nothing reads its tables from outside, its callers use a port or an event, and its HTTP routes live under its own prefix. `rls-check` and depcruise prove the first two; reviewers check the rest. Today every module runs in one process (ADR 0001, ADR 0024).

## Ownership

`.github/CODEOWNERS` has one default owner. Add path owners per module when a second maintainer joins; until then review gates are the checks above plus the scoped review lanes in `docs/reports/`.

## Review cadence

- Per PR: `pnpm check` for the touched packages, the matching reviewer (typescript, react, database, security).
- Per phase gate: full `turbo run check --continue --concurrency=4`, security and database review, report in `docs/reports/`.
- Findings that are not fixed go to `docs/prompts/PROGRESS.md` follow-ups with an owner.
