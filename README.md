# wise-biz

Universal, multi-tenant point-of-sale platform: offline-first POS (Android, iOS, web, desktop), store console, storefront and platform admin.
One TypeScript monorepo; modules are bounded contexts that can be extracted as services.

## Prerequisites

- Node.js 24 LTS (`nvm use` reads `.nvmrc`)
- pnpm 12 via Corepack: `corepack enable` (version pinned in `package.json` `packageManager`)
- Git (hooks are installed by Lefthook on `pnpm i`)
- Graphviz `dot`, only for `pnpm deps:graph`

## Quickstart

```bash
corepack enable
pnpm i          # install + git hooks
pnpm check      # lint + typecheck + test + boundary rules (must pass before commit)
```

| Script | What it does |
|---|---|
| `pnpm check` | `turbo run check`: lint, typecheck, test in every workspace + `depcruise` |
| `pnpm lint` / `typecheck` / `test` | One task across all workspaces (cached by Turborepo) |
| `pnpm depcruise` | Module boundary rules (`.dependency-cruiser.cjs`) |
| `pnpm format` | Prettier write |
| `pnpm deps:graph` | Dependency graph to `docs/deps-graph.svg` |
| `pnpm changeset` | Record a package change (Changesets) |
| `pnpm clean` | Remove build outputs, caches and `node_modules` |

Commits follow Conventional Commits; the scope is a workspace folder name or one of `docs`, `ci`, `infra`, `deps`, `release` (`commitlint.config.js`).

## Layout

`apps/*` deployables · `modules/*` server bounded contexts · `packages/*` framework-free libraries (`config`, `testing`, …) · `services/*` extracted or non-TS services. Details: `ARCHITECTURE.md`.

## Read next

- [`AGENTS.md`](AGENTS.md): rules and the doc map
- [`docs/prompts/README.md`](docs/prompts/README.md): build steps and progress
