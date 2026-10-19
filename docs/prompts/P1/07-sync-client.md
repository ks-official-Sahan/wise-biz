# P1-07 · `@wise-biz/sync` client + local database

Effort: **H** · Needs: P1-06 · Gate: confirm plan (local schema + storage adapter API)
Read: `docs/architecture/offline-sync.md` (all), `docs/architecture/performance.md` (Checkout budgets)
Libraries: expo-sqlite (native + web; web needs COOP/COEP, no `withExclusiveTransactionAsync` on web), better-sqlite3 (Node tests now, Electron later), SQLite FTS5, `@wise-biz/crypto`, `@wise-biz/ids` (HLC), `@wise-biz/http-signatures`
Skills: `ecc:latency-critical-systems`, `ecc:tdd-workflow`, `vercel-react-native-skills`

## Goal
A platform-agnostic client library that makes the device the source of truth for selling: durable local writes, a signed outbox, reliable push/pull, and the guarantees in offline-sync.md, proven by chaos tests before any UI exists.

## Scope
1. `StorageAdapter` port: `exec`, `query`, `transaction(fn)`, prepared statements, `close`; adapters `expo-sqlite` (native + web) and `better-sqlite3`. **Single-writer queue** in front of every adapter.
2. Local schema + migrations: dataset tables mirroring the feed, FTS5 index for search, `device_outbox`, `drafts` (carts), `kv` (cursors, snapshot versions), `local_movements`. WAL + `synchronous=FULL` for outbox writes.
3. `createCommand(type, payload)`: assigns `seq` (monotonic, persisted), HLC timestamp, `prev_hash`, `hash`, Ed25519 signature (key from a `KeyStore` port; platform impls in P1-08/P1-12) and writes it in the same local transaction as the domain rows (API: `local.transaction(tx => { …; tx.enqueue(cmd) })`).
4. Push loop: batches ≤ 100, exponential backoff + jitter, handles `409 SEQUENCE_GAP`, quarantine response (stop + surface), auth expiry; never reorders.
5. Pull loop: per-dataset cursors, bootstrap from snapshot URLs, apply changes in transactions, realtime hint subscription (SSE), schedule with priority below UI work.
6. In-memory indexes rebuilt incrementally after pulls: `Map<barcode, variantId>`, quick-key lists.
7. Guards and tools: `unsyncedCount()`, `oldestUnsyncedAt()`, sign-out guard, encrypted outbox export file (AES-GCM with a key derived from tenant key material; document) for manual upload.
8. Observability hooks: timings (scan→line, sale commit), sync lag, errors → host app logger.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-researcher (haiku) | — | expo-sqlite current API (native + web, transactions, prepared statements), better-sqlite3 API |
| 2 | wb-builder (sonnet) | `packages/sync/src/storage/**`, `src/schema/**` | Items 1–2 |
| 3 | wb-builder (sonnet) | `packages/sync/src/outbox/**`, `src/push/**` | Items 3–4, 7 |
| 4 | wb-builder (sonnet) | `packages/sync/src/pull/**`, `src/indexes/**` | Items 5–6, 8 |
| 5 | wb-tester (sonnet) | `packages/sync/test/chaos/**` | Fake server + real SQLite: crash between local commit and push, duplicate sends, lost acks, clock skew ±10 min, 10k queued commands, server 500s, quarantine |

## Acceptance
- Chaos suite: zero lost or duplicated commands across 1,000 randomized runs (fast-check model-based test).
- Local sale commit (10 lines + tenders + outbox) < 15 ms p95 with better-sqlite3 on CI; record expo-sqlite numbers in P1-08.
- Barcode map lookup < 0.1 ms; FTS query on 100k variants < 30 ms.
- Package has no React dependency; runs in Node, Hermes (checked in P1-08), and browser.

## Review
`ecc:typescript-reviewer`, `ecc:security-reviewer`, `ecc:performance-optimizer`. Then one `model: "opus"` design review of the outbox + chain logic (allowed once this phase).
