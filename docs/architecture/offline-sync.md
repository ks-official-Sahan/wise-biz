# Offline-first and sync

Goal: a registered terminal can sell for days without internet, with zero lost sales and no silent conflicts.

## Device storage

| Platform | Engine | Notes |
|---|---|---|
| Android / iOS | expo-sqlite (WAL mode) | Encrypted with SQLCipher build or key from Keystore/Keychain |
| Web | expo-sqlite web (wa-sqlite on OPFS) | Needs COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`). `withExclusiveTransactionAsync` is not available on web → use `withTransactionAsync` and a single writer queue. Web terminals are **secondary** (no hardware drawer, limited printing). |
| Electron | better-sqlite3 in main process, exposed via IPC | Key from OS keychain via `safeStorage` |

One writer per DB: all writes go through `@wise-biz/sync`'s serialized write queue. Reads are free.

## What lives on the device

| Dataset | Direction | Refresh |
|---|---|---|
| Catalog (variants, barcodes, units, images metadata) | down | delta by cursor |
| Prices, tax rules, promotions, FX snapshot | down | delta; versioned with validity |
| Stock balances for this branch | down | delta, informational only |
| Customers (recent + branch-relevant) + loyalty balances | down | delta; on-demand lookup when online |
| Permissions snapshot + operator PIN hashes | down | signed by server, expires (default 72 h) |
| Entitlements token | down | signed, offline grace 7 days |
| Theme, receipt template | down | on publish |
| Sales, returns, shifts, drawer events, stock counts | up | outbox |

Images: thumbnails cached (size-capped LRU); originals on demand.

## Up: command outbox

```
device_outbox(seq integer primary key, id uuid, type text, payload json, hash blob, signature blob, created_at, attempts, last_error, status)
```

1. Completing a sale runs **one local transaction**: insert sale + lines + tenders + local stock movements + outbox row. Then the UI confirms. No network.
2. Each command carries: `id` (UUIDv7, also the idempotency key), `device_id`, `device_seq` (monotonic), `hlc` (hybrid logical clock), `prev_hash`, `hash = sha256(canonical(payload) ‖ prev_hash)`, `signature = Ed25519(device_key, hash)`.
3. Sync worker pushes in `seq` order in batches (≤ 100 commands or 256 KB), with exponential backoff + jitter.
4. Server per command: verify device active → verify signature → verify chain continuity (`prev_hash` matches last accepted for this device) → check idempotency (`unique(tenant_id, terminal_id, device_seq)`) → apply in a transaction → ack with server ids (`invoice_no`).
5. Gaps in `device_seq` → server answers `409 SEQUENCE_GAP` with expected seq; device resends from there. Chain break → device quarantined, owner alerted (tamper or corruption).

Commands, not row diffs: the server re-runs business rules (prices honored as snapshotted, permissions checked against the snapshot version the device held), so a Django backend can process the same commands later.

## Down: delta pull

- Server keeps a per-tenant change feed (`sync_changes(tenant_id, scope, entity, entity_id, op, version, changed_at)`), filled by outbox consumers.
- Device sends `cursor` per dataset; server returns up to N changes + next cursor. Keyset pagination, no offsets.
- Realtime nudge: WebSocket/SSE message "dataset X advanced" → device pulls. Push is a hint; pull is the truth.
- First boot: bulk snapshot (gzip NDJSON from object storage, signed URL), then deltas.

## Conflict policy

| Situation | Rule |
|---|---|
| Sale while offline sells more than stock | Accept. Balance goes negative. `inventory.balance.negative` exception for review. |
| Price changed while offline | Sale keeps the price the device showed (snapshot); report flags "stale price" sales if beyond threshold. |
| Permission revoked while offline | Commands after revocation time are accepted but flagged; device stops accepting the operator once it syncs. Snapshot expiry bounds the window. |
| Customer edited on two devices | Field-level last-writer-wins by HLC for profile fields; loyalty points are a ledger (no conflict). |
| Master data (products, prices) | Server-authoritative; devices never edit master data offline (except P2 "quick add product" which creates a pending product reviewed later). |
| Same cart opened on two terminals (LAN handoff) | Cart has an owner lease; transfer moves the lease. |
| Loyalty redemption offline | Allowed up to cached balance minus pending, capped per tenant setting (default 50% of balance, max value X). |

## LAN peer sync (P2)

Terminals in one branch discover each other (mDNS/Bonjour, or a designated "hub" terminal / Electron hub). They exchange outbox commands and cart handoffs over mutually authenticated TLS using device certificates. Hub forwards to cloud when online. Keeps stock and sale numbers coherent inside a store during an outage, a gap Toast documents for its own offline mode.

## Offline payments

| Tender | Offline |
|---|---|
| Cash | Yes |
| Card via semi-integrated terminal | Only if terminal supports store-and-forward; per-tenant cap per transaction and per day; risk accepted by owner in settings |
| QR / online / payment links | No (hidden) |
| Store credit, vouchers | Yes, against cached balance with cap |
| Gift cards (external) | No |

## Durability guarantees

- SQLite WAL + `synchronous=FULL` for the outbox table writes.
- App uninstall/clear warning: if unsynced commands exist, the app blocks sign-out and shows the count; owner can export an encrypted outbox file for manual upload.
- Device health heartbeat reports `unsynced_count`, `oldest_unsynced_at`; console alerts after threshold.

## Persistence of drafts (carts, forms)

- Carts persist to SQLite on every change (debounced 150 ms) and Redux persist for UI state.
- TTL: carts expire after configurable hours (default 12 h) or shift close, with a prompt; prices revalidated when resumed after a price-version change.
- Forms in console persist to local storage with a schema version; invalidated on schema change or logout.

## Library choice

Custom sync over PowerSync/ElectricSQL (ADR 0003): we need signed, hash-chained commands, server-side business-rule replay, LAN peer sync, and Django portability. PowerSync remains a fallback option for the read path if delta pull becomes costly to maintain.
