# P2-12 · LAN peer sync between terminals

Effort: **H** · Needs: P1-16 · Gate: confirm plan (topology: hub terminal vs mesh)
Read: `docs/architecture/offline-sync.md` (LAN peer sync, Conflict policy), `docs/architecture/security.md` (Devices)
Libraries: mDNS/Bonjour discovery (RN + Electron), TLS with device certificates (mutual auth), WebSocket
Skills: `ecc:latency-critical-systems`, `ecc:security-review`, `ecc:network-architect` agent (optional review)

## Goal
When the internet is down, terminals in one store still see each other's sales, stock, and carts, closing the gap documented in competitors' offline modes.

## Scope
- Topology: one hub (Electron desktop preferred, else elected terminal) relays commands; peers discover via mDNS; mutual TLS using device keys certified by the server (cert issued at enrollment).
- Exchange: outbox commands (read-only replicas of other terminals' commands for local projections), stock deltas, cart handoff with lease transfer, invoice/sale number coherence.
- Hub forwards to cloud when online; dedupe by command id end-to-end.
- Failure handling: hub loss → re-election; split brain → commands still unique and server-ordered.

## Delegation
wb-researcher (haiku) discovery libs for RN + Electron → wb-builder (sonnet) `packages/sync/src/lan/**` → wb-builder (sonnet) Electron hub → wb-tester (sonnet) multi-process simulation (3 terminals, network partitions).

## Acceptance
- Three terminals offline from cloud: a sale on one updates stock on others < 2 s; cart handoff works; after reconnect, server state equals the union with no duplicates.
- Unenrolled device cannot join the LAN mesh.

## Review
`ecc:security-reviewer`, `ecc:performance-optimizer`
