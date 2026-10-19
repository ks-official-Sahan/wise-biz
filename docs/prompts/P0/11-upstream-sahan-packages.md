# P0-11 · Upstream `@sahan-sac` package upgrades

Effort: **M** · Needs: P0-08 · Gate: confirm plan
**Run this step in a session opened on the Sahan repo** (`github.com/ks-official-Sahan/Sahan`), not wise-biz. Its own AGENTS.md rules apply there. Copy this file into that session's prompt.
Read (wise-biz): `docs/research/sahan-packages.md` (Gaps, Plan). Read (Sahan): `packages/README.md`, each package README touched.
Libraries: Better Auth, Drizzle, changesets/semver
Skills: `ecc:api-design`, `ecc:security-review`

## Goal
Generalise the Sahan packages where wise-biz needs it, backwards compatible, so both projects share one maintained base.

## Scope
1. `auth-kit` RBAC: optional `scope` on permission checks (`{ tenantId, branchId }`), matrix per scope key; existing global behavior unchanged when no scope is given.
2. `auth-kit` adapters: ID generator injection (default stays as today; wise-biz passes UUIDv7).
3. `auth-kit` Hono helpers: confirm Better Auth engine + Hono path works without Next.js imports (tarball consumer test).
4. `media-kit`: tenant folder prefix option and a pre-upload quota hook; no behavior change when unset.
5. `ai-core`: optional per-call budget/quota hook and an audit callback.
6. `email-kit`: allow layout tokens (colors, logo URL) per send.
7. Version bumps (minor), changesets, READMEs, the repo's tarball verification passes.
8. Back in wise-biz (separate small PR): bump versions, use the new options.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-builder (sonnet) | `packages/auth-kit/**` | Items 1–3 |
| 2 | wb-builder (sonnet) | `packages/{media-kit,ai-core,email-kit}/**` | Items 4–6 |
| 3 | wb-tester (haiku) | package tests | Backward-compat tests: old call sites unchanged |

(If the `wb-*` agents are not present in the Sahan repo, use `general-purpose` with `model: "sonnet"` / `"haiku"` and paste the agent rules.)

## Acceptance
- Sahan: `pnpm test`, `pnpm typecheck`, `pnpm verify:packages` pass; Sahan site builds unchanged.
- wise-biz: `pnpm check` passes after the bump.

## Review
`ecc:typescript-reviewer`, `ecc:security-reviewer` (auth-kit)
