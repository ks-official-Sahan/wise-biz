# ADR 0008: Internal packages ship TypeScript source; toolchain pins

Status: accepted · 2026-10-19

## Context
P0-01 wires the monorepo. Internal `@wise-biz/*` packages need to be importable by Vitest, ESLint, Node scripts and (later) Expo/Next bundlers without a per-package build step slowing the inner loop. TypeScript 7 (native) is out, but typescript-eslint 8 supports only `typescript <6.1`.

## Decision
- Internal packages expose `.ts` source through `exports` (no `dist` build). Node 24 LTS runs it by type stripping; bundlers compile it.
- `tsconfig/base.json` sets `erasableSyntaxOnly` (no `enum`, `namespace`, parameter properties) and `verbatimModuleSyntax`, so every file is strippable. `allowImportingTsExtensions` + `noEmit`: relative imports carry `.ts`.
- `tsconfig/node.json` uses `module`/`moduleResolution: NodeNext` (Node rejects extensionless and directory imports); browser/RN presets keep `bundler`.
- Pins: Node 24 LTS, pnpm 12 (Corepack), TypeScript 6.0.x, ESLint 10 flat config. `eslint-plugin-react` and `eslint-plugin-jsx-a11y` are not used until they support ESLint 10.
- ESLint presets are plain JS (`// @ts-check`) factories taking `{ root }`, so a preset can read the package's `wiseBiz.runtime` and ban Node built-ins for `universal` packages.

## Consequences
No build step for internal packages; Turbo `build` stays empty until a package is published (then add `tsc -p tsconfig.build.json` to that package only). Move to TypeScript 7 when typescript-eslint supports it. A published package needs a real build and `.d.ts` output; decide per package with Changesets.
