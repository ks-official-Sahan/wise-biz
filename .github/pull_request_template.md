## What

<!-- One or two sentences: what changes. -->

## Why

<!-- Problem or ticket this solves. Link the docs/prompts step or issue. -->

## Contract changes

<!-- Changes to @wise-biz/contracts, events (docs/architecture/events.md), or HTTP API. "None" if none. -->

## Migration

<!-- DB migrations, data backfills, feature flags, rollout order. "None" if none. -->

## Perf / query notes

<!-- New queries: EXPLAIN output or index used. Hot path (checkout) impact. "None" if none. -->

## Screenshots (UI)

<!-- Before/after for UI changes, light and dark theme. Delete section if no UI change. -->

## Security notes

<!-- Auth, tenant scope, secrets, PII/card data, new deps (license checked). "None" if none. -->

## Checklist

- [ ] `pnpm check` is green locally
- [ ] Changeset added if a published package changed (`pnpm changeset`)
- [ ] Tenant scope, audit, and outbox rules followed for any mutation (AGENTS.md)
