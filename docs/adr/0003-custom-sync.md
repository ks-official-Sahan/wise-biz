# ADR 0003: Custom command-based sync

Status: accepted · 2026-10-18

## Context
Offline selling must never lose a sale, must be tamper-evident, must re-run business rules on the server, and must be processable by a future Django backend. Off-the-shelf engines sync rows (PowerSync: SQLite upload queue + server-authoritative state; ElectricSQL: read-path focus, cloud offering shut down).

## Decision
- Up: device outbox of **signed, hash-chained commands** (`CompleteSale`, `CloseShift`, …), idempotent by UUIDv7 + device sequence.
- Down: per-tenant change feed with cursors, bulk snapshot for first boot, realtime nudge.
- LAN peer sync between terminals in P2.
- Library: `@pos/sync` (transport-agnostic, used by Expo and Electron).

## Consequences
- More code to own and test (property tests, chaos drills required).
- Full control over conflict policy, audit, and signatures.
- PowerSync stays an option for the read path if the change feed becomes costly.
