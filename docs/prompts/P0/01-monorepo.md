# P0-01 · Monorepo, tooling, boundaries

Effort: **M** · Needs: — · Gate: none
Read: `ARCHITECTURE.md` (Stack, Repository layout), `docs/CONVENTIONS.md`
Libraries: pnpm workspaces, Turborepo, TypeScript, ESLint flat config + typescript-eslint, Prettier, Vitest, Changesets, dependency-cruiser, Lefthook, commitlint
Skills: `ecc:coding-standards`, `ponytail`

## Goal
An empty but fully wired monorepo where `pnpm check` runs lint, typecheck, test, and boundary rules across every workspace, and bad commits are rejected locally.

## Scope
1. Root: `package.json` (`packageManager` pinned pnpm, `engines.node` = current LTS), `pnpm-workspace.yaml` (`apps/*`, `modules/*`, `packages/*`, `services/*`), `turbo.json` tasks `build`, `lint`, `typecheck`, `test`, `check` with correct `dependsOn`/outputs/caching, `.npmrc` (`link-workspace-packages=true`), `.nvmrc`, `.editorconfig`, `.gitignore`, `.gitattributes`.
2. `packages/config`:
   - `tsconfig/base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ESM, `moduleResolution: bundler`; presets `node.json`, `react.json`, `react-native.json`, `library.json`.
   - ESLint flat config presets `base`, `node`, `react`, `react-native`, `next`. Rules: no `any`, no floating promises, import order, no default exports in packages, and a rule banning `node:*` imports in packages marked `"wiseBiz": { "runtime": "universal" }` in package.json.
   - Prettier config.
3. `packages/testing`: Vitest preset (v8 coverage, thresholds configurable per package); helpers come later.
4. `.dependency-cruiser.cjs` rules:
   - `modules/<a>/**` must not import `modules/<b>/**` except `modules/<b>/contracts.ts`;
   - `packages/**` must not import `apps/**` or `modules/**`;
   - `modules/*/domain/**` must not import adapters, DB clients, Hono, or Node IO;
   - no circular dependencies.
5. Lefthook: pre-commit (prettier + eslint on staged files), commit-msg (commitlint conventional; scopes = workspace names + `docs`, `ci`, `infra`, `deps`).
6. Changesets initialised (independent versioning; `@wise-biz/*` packages private for now).
7. Root scripts: `check` (turbo lint typecheck test + depcruise), `format`, `clean`, `deps:graph`.
8. `README.md`: what wise-biz is (2 lines), prerequisites, quickstart, links to `AGENTS.md` and `docs/prompts/README.md`.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | Current Turborepo, ESLint flat config, Lefthook, dependency-cruiser config syntax |
| 2 | wb-scaffolder (haiku) | root files, `packages/config/**`, `packages/testing/**`, `lefthook.yml`, `commitlint.config.*`, `.changeset/**` | Items 1–3, 5–7 |
| 3 | orchestrator | `.dependency-cruiser.cjs`, `README.md` | Items 4, 8 |

## Acceptance
- `pnpm i && pnpm check` passes.
- A temporary fixture importing `modules/b/internal.ts` from `modules/a` fails `pnpm depcruise` (remove the fixture after).
- `git commit -m "bad message"` is rejected; `git commit -m "chore(config): init"` passes.
- `pnpm turbo run check --dry=json` shows caching configured for all tasks.

## Out of scope
Apps, Docker, CI workflows (P0-02, P0-03).

## Review
`ecc:typescript-reviewer`
