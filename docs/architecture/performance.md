# Performance

## Checkout budgets (device, p95)

| Step | Budget | How |
|---|---|---|
| App cold start to sell screen | ≤ 2.5 s (mid-range Android) | Hermes, lazy routes, catalog index warmed in background |
| Barcode scan → line visible | ≤ 50 ms | In-memory `Map<barcode, variantId>` built at boot from SQLite; fallback indexed SQLite lookup |
| Search keystroke → results | ≤ 80 ms | Local FTS5 table on device; debounce 120 ms; cancel stale queries |
| Add line → totals updated | ≤ 16 ms (one frame) | Pure pricing engine, incremental recompute of changed line only, memoized cart selectors |
| Cash tender → sale stored | ≤ 150 ms | One SQLite transaction, prepared statements |
| Sale stored → print starts | ≤ 1 s | ESC/POS bytes prebuilt from template; printer connection kept warm |
| Card tender | Terminal-bound (2–8 s) | Show terminal status live; never block the UI thread |

No network call on these paths. Sync runs in a background task with low priority.

## Client rules

- Lists virtualized (FlashList / react-window). Product grid images pre-sized thumbnails.
- Redux: normalized cart (`entities` + ids), `createSelector` memoization, no derived data in state.
- TanStack Query only for online views (console, lookups); `staleTime` by data class; prefetch on hover/focus.
- Event handling: scanner input buffered (keyboard-wedge scanners detected by inter-key timing < 30 ms); search debounce 120 ms; resize/scroll throttle 16 ms (rAF); button double-tap guard (idempotent actions).
- Animations: transform/opacity only, ≤ 200 ms, respect reduced motion. GSAP only in console/storefront, never in the checkout path.
- Bundle: POS JS bundle budget 3 MB (Hermes bytecode); console route JS ≤ 200 KB gzip.

## Server rules

| Rule | Detail |
|---|---|
| No N+1 | Repositories expose batch methods (`getMany(ids)`); `?include` loads relations with one `= any($1)` query each; dataloader per request for GraphQL-like fan-out; CI test asserts query count on key endpoints |
| Indexing | See `data-model.md` index rules; `pg_stat_statements` reviewed weekly; slow query log ≥ 200 ms |
| Connection pooling | PgBouncer (transaction mode) or Neon pooler; `SET LOCAL` for tenant in each tx |
| Batching | Sync commands applied in batches with one transaction per command (atomic per sale) but shared prepared statements; inserts multi-row |
| Read replicas | Reports and analytics read from replica; TPS writes to primary |
| Projections | Dashboards read rollup tables, never raw sales |
| Payload | gzip/br; fields trimmed; ETag + 304 for catalog pulls |

## Caching layers

| Layer | What | Invalidation |
|---|---|---|
| Device SQLite | Catalog, prices, permissions | Delta sync |
| Browser HTTP | Static assets (immutable, hashed), storefront pages | Content hash; `stale-while-revalidate` |
| Cloudflare edge | Storefront HTML/JSON, public catalog images, shortlinks | Tag-based purge on `catalog.*`, `pricing.*` events |
| nginx micro-cache | Public GETs, 1–5 s | TTL |
| Redis | Permission matrix, entitlements, session lookups, idempotency results, rate limits, hot product lookups | Versioned keys `t:{tenant}:perm:v{n}`; bump version on change |
| Postgres | Rollups, materialized projections | Event consumers |

Cache keys always include `tenant_id`. Never cache personal data at the edge.

## Load and capacity tests

- k6 scenarios: sync burst (1k devices reconnecting with 500 queued sales each), Black-Friday checkout (2k sales/s), dashboard fan-out (10k SSE clients).
- Run in CI nightly against staging; fail on budget regression > 10%.
- Device performance: Maestro/Detox flows timed on a low-end Android device in CI device farm.
