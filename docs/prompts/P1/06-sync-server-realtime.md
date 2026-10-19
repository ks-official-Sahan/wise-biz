# P1-06 · Sync server + realtime

Effort: **H** · Needs: P1-05 · Gate: confirm plan
Read: `docs/architecture/offline-sync.md` (all), `docs/adr/0003-custom-sync.md`, `docs/architecture/events.md` (Realtime fan-out), `docs/architecture/performance.md` (Server rules)
Libraries: Hono streaming/SSE or `ws`, Redis pub/sub, object storage (media-kit S3/R2) for snapshots, k6
Skills: `ecc:latency-critical-systems`, `ecc:redis-patterns`, `ecc:backend-patterns`

## Goal
Terminals push signed command batches and pull deltas reliably at scale. The server never loses, duplicates, or silently accepts a tampered command.

## Scope
1. `POST /v1/sync/commands` (requireTerminal): batch ≤ 100 commands / 256 KB. Per command in `device_seq` order: verify signature → verify `prev_hash` continuity (`device_sync_state(device_id, last_seq, last_hash)`) → idempotency (seq + id) → dispatch to P1-05 handler → per-command transaction → ack `{ seq, status, serverIds }`. Gap → `409 SEQUENCE_GAP { expectedSeq }`. Chain break → quarantine device (`devices.device.quarantined`), alert owner, stop processing.
2. **Change feed**: `sync_changes (tenant_id, dataset, scope_key, entity, entity_id, op, version, changed_at)` filled by consumers of catalog/pricing/inventory/customers/theming/policy events. Datasets: `catalog`, `prices`, `tax`, `promotions`, `stock_branch`, `customers_recent`, `policy_snapshot`, `entitlements`, `theme`, `receipt_template`.
3. `GET /v1/sync/changes?dataset=&cursor=&limit=` keyset by `(changed_at, id)`, returns entities (batched fetch per entity type, no N+1) + next cursor; ETag support.
4. **Bootstrap snapshot**: per tenant + branch + dataset, gzip NDJSON in object storage, rebuilt on demand or nightly; `GET /v1/sync/bootstrap` returns signed URLs + cursor to continue from.
5. `apps/realtime`: SSE (and WS if needed for LAN later) with device/user auth; channels `t:{tenant}:b:{branch}:{dataset}`; consumers publish "dataset advanced" hints to Redis; coalesce + throttle 4 msgs/s per connection.
6. Device health surfaced: `unsynced_count`, lag; metrics for sync queue depth and apply latency.
7. k6 scenario: 1,000 devices reconnecting, each pushing 500 commands.

## Delegation
| # | Agent (model) | Owns | Task |
|---|---|---|---|
| 1 | wb-db (sonnet) | `modules/sync/migrations/**` | sync_state, sync_changes, indexes |
| 2 | wb-builder (sonnet) | `modules/sync/src/push/**` | Item 1 |
| 3 | wb-builder (sonnet) | `modules/sync/src/pull/**`, consumers, bootstrap | Items 2–4 |
| 4 | wb-builder (sonnet) | `apps/realtime/**` | Item 5 |
| 5 | wb-tester (haiku) | `modules/sync/test/**`, `load/k6/sync-burst.js` | Acceptance + item 7 |

## Acceptance
- Tests: forged signature, broken chain, seq gap, duplicate batch, out-of-order batch, mixed valid/invalid batch (valid ones before the failure are committed, response says where it stopped).
- Pull: 10k changes paged with no duplicates or gaps; query count constant per page.
- Realtime hint arrives < 1 s after a price change commit (local).
- k6: 500k commands applied with zero loss; report p95 apply latency and throughput in PR.

## Review
`ecc:security-reviewer`, `ecc:database-reviewer`, `ecc:performance-optimizer`
