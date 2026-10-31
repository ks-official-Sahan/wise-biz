# ADR 0016: The device sync client is one universal package over a storage port, with a single-writer queue

Status: accepted · 2026-10-31

## Context
The device is the source of truth for selling (ADR 0003). The client must run in Node (tests, Electron main), browsers, Hermes and Expo web, with three different SQLite drivers (better-sqlite3, expo-sqlite, a WASM build) whose APIs and transaction rules differ. Two properties must not depend on the driver: a sale and its signed command are written atomically, and commands leave the device in sequence order without loss or duplication.

## Decision
- **`@wise-biz/sync` is universal** (no Node built-ins, no React): storage, schema, outbox, push loop, pull loop, hint stream, indexes and a `createSyncClient` facade. Platform code is injected through small ports: `StorageAdapter`, `KeyStore`, `Transport` / `PullTransport` (signed HTTP, built in P1-08), `Gunzip`, `OpenStream`, `Timers`. Shipped adapters live with their platform (better-sqlite3 in test support now, Electron in P1-12, expo-sqlite in P1-08).
- **Single-writer queue** in front of every adapter. All calls run in arrival order and a transaction holds the queue until commit or rollback. Callers use the `tx` handle inside a transaction, never the database (it would wait for itself). The arrival order is the outbox order.
- **Outbox = chain head in `kv` + rows in `device_outbox`**, written in the same transaction as the domain rows (`outbox.transaction(tx => { …; tx.enqueue(type, body) })`). The sequence number and `prev_hash` come from the head inside the transaction, so a rolled-back sale leaves no hole. `commandHash` is defined once, in this package, and `modules/sync` imports it; a pinned vector (computed independently from the RFC 8785 text) guards the wire contract.
- **Durability:** WAL with `synchronous=FULL`. A local sale commit (10 lines, a tender, the signed row) measures p50 6 ms, p95 8 ms.
- **Push loop:** one request in flight, oldest first, ≤ 100 commands / 200 KB, never skipping a command. A lost answer is repaired by resending (the server replays). Failures map to retry (exponential backoff, full jitter, `Retry-After`), `auth` (wait for sign-in), or `blocked` (quarantine, revoked, request-level refusal, or divergence). A `SEQUENCE_GAP` rewinds acked commands the server lost when they are still in the outbox, and blocks as `diverged` otherwise.
- **Pull loop:** per-dataset cursor committed in the same transaction as the page it covers; first run bootstraps from the snapshot; an unknown cursor re-bootstraps. Hints (SSE, ADR 0015) and a fallback poll only decide *when* to pull. The FTS5 variant index and the in-memory barcode map are kept in step with each page.
- **Export for manual upload:** pending commands encrypted with AES-256-GCM under an HKDF-SHA256 key from tenant key material (fresh salt and nonce per file, header as AAD). The commands inside are already signed, so tampering shows on the server. The upload endpoint is a follow-up.

## Consequences
- A host must provide a `Gunzip` (Node zlib, `DecompressionStream`, or fflate on Hermes) and a streaming `OpenStream` (React Native's fetch does not stream).
- A device that loses its database but keeps its key restarts at sequence 0 and is quarantined (ADR 0015): the owner re-enrols it. The outbox export is the way to save its unsynced work first.
- The queue serializes everything on one connection. That is correct for SQLite's single writer, and it means a long transaction (a 100k-row snapshot, about 2 s) blocks selling writes for its duration; snapshots happen at first run or after a reset, with the sell screen not yet usable.
