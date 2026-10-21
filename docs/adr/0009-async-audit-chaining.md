# ADR 0009: Asynchronous audit hash chaining

Status: accepted · 2026-10-20

## Context
`audit.audit_log` is written inside every mutation's transaction (AGENTS.md rule 5). Chaining each row to the previous one *in that transaction* needs the tenant's current head, which serializes every write of a tenant on one row lock and puts a hash computation on the checkout hot path (1,000 commands/s target, `performance.md`).

## Decision
- Mutations insert audit rows **without** `prev_hash`/`hash`/`chain_seq`. `wb_app` has INSERT only.
- The `audit-chainer` worker (role `wb_chainer`) runs every ~2 s: per tenant, in one transaction it locks `audit.chain_heads`, takes unchained rows (`hash IS NULL`, `FOR UPDATE SKIP LOCKED`), assigns consecutive `chain_seq`, and sets `hash = link(prev_hash, canonical(row))` (`@wise-biz/audit-chain`, RFC 8785).
- **Chain order is the chainer's `chain_seq`, not the identity `id`.** Ids are allocated at insert time but transactions commit in a different order; a lower id can become visible after higher ids were chained. The chain proves *what was recorded and in what order it was sealed*, which is what tamper evidence needs.
- A trigger rejects DELETE and any UPDATE except NULL → value on `chain_seq`, `prev_hash`, `hash`. Monthly partitions (`ensure_partitions`, 3 months ahead) carry forced RLS.
- Daily `audit.anchors` row per tenant: Merkle root (RFC 6962) of the day's hashes plus the head. Verification passes the anchor (`expectedHead`/`expectedLength`) because tail truncation is only detectable against one (P0-05).

## Consequences
- Rows are unchained for a few seconds; an attacker with DB write access in that window could alter an unchained row. Mitigations: `wb_app` cannot UPDATE; the window is bounded and monitored (chainer lag metric).
- No per-tenant lock on the write path; audit inserts stay O(1).
- Anchors are not yet signed or exported to WORM storage — follow-up before production.
