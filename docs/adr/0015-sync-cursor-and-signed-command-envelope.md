# ADR 0015: The sync cursor is a transaction position, and a signed command covers its type and sequence number

Status: accepted · 2026-10-31

## Context
ADR 0003 chose signed, hash-chained commands up and a cursor-based change feed down. Two details were left open and both decide whether "no lost sale, no silent gap" holds.

1. **Commands.** The first sketch hashed only the payload and the previous hash. The command type and the device sequence number travel outside the payload, so a captured signed command could be relabelled (dispatched to another handler whose schema accepts the same body) or renumbered without breaking the signature.
2. **Change feed.** A cursor made of a timestamp or a sequence skips rows when two writers commit out of order: the writer that took the lower id commits last, and a device that already moved past it never sees the row. Consumers of different topics run concurrently, so this is real.

## Decision
- `hash = sha256(canonical({ type, seq, body without meta }) ‖ prev_hash)` (RFC 8785 canonical JSON, `@wise-biz/crypto`), signed with the device's Ed25519 key. The server recomputes it from the received body, so a body changed after signing fails as `BAD_SIGNATURE`. A bad signature, a bad hash, a broken chain, or the same sequence number with another hash suspends the device in the same transaction (`devices.device.quarantined`) and stops the batch. A gap only stops it (`SEQUENCE_GAP`, `expectedSeq`).
- One transaction per command: the device's chain row is locked `FOR UPDATE`, the handler runs under a savepoint, the log row and the chain move commit together. A business-rule or data error from a handler (DomainError, SQLSTATE 22/23) rolls the handler back, is logged `rejected`, and the chain moves on, so one bad command never blocks a terminal. Infrastructure errors are rethrown and the whole retry is idempotent. A trigger lets the chain row advance by exactly one.
- The change feed row stores the producer's fat event payload (no cross-module reads on pull) and its transaction id (`xid8`). The cursor is `(txid, id)`. A row is readable only below `pg_snapshot_xmin(pg_current_snapshot())`, the oldest transaction still in flight, so a late commit can never appear behind a cursor a device holds. Bootstrap snapshots read the newest row per entity and the cursor in one statement, so state and cursor always agree.

- **Realtime hints.** `apps/realtime` is a hint channel, never a data channel: a notice says "this dataset moved", the terminal pulls with its cursor. The `sync.changes` consumer publishes one notice per touched channel to Redis `rt:{tenantId}:{channel}` while still inside its transaction, so a hint can beat the commit (and the xmin visibility rule can hold rows back further); terminals therefore keep a slow poll as the fallback and treat `event: ready` as "pull once now". Channels are `all:{dataset}` and `l:{locationId}:stock_branch` under the tenant (not `b:{branch}`: resolving a stock row's branch would need a tenancy read in the consumer; the ticket lists the branch's locations instead).
- **Stream auth is a ticket.** The API checks the terminal's signed request once and mints a 120 s HMAC ticket (`POST /v1/sync/stream-ticket`) that carries the exact channels the terminal may hear. `apps/realtime` verifies the HMAC only (no database), reads it from `Authorization: Bearer` (never the URL), and ends every stream after 5 minutes so a revoked terminal cannot listen long; the terminal reconnects with a new ticket. One Redis pattern subscription per tenant per instance, 4 messages/s per connection with hints coalesced, slow clients dropped at 64 KB of backlog.

## Consequences
- Devices must hash `{ type, seq, body }` exactly as above (the shared helper lives in `@wise-biz/sync`). A device that clears its outbox but keeps its key restarts at seq 0, fails the chain check and is suspended; the owner re-enrols it (deliberate: indistinguishable from tampering).
- Pull has a small visibility delay while a long transaction is open somewhere in the database. The feed grows with every change; compaction below a floor cursor is a follow-up job.
- Datasets whose producers do not exist yet (customers, policy snapshot, entitlements, theme, receipt template) are accepted by the schema and wired when those modules ship.
