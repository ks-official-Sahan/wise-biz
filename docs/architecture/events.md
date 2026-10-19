# Events, outbox, Kafka

## Flow

```
use case tx ──► outbox (same DB tx) ──► relay ──► Kafka topic ──► consumers ──► projections / side effects
```

- **Outbox** table per database: `outbox(id uuid, tenant_id, topic, key, type, version, payload jsonb, headers jsonb, created_at, published_at)`.
- **Relay** (`apps/workers`): reads unpublished rows with `for update skip locked` in batches of 500, publishes, marks `published_at`. Multiple relay replicas are safe. Postgres logical decoding (Debezium) is the upgrade path at high volume.
- Delivery is **at-least-once**. Every consumer is idempotent: `processed_events(consumer, event_id)` unique, inserted in the consumer's own transaction.
- Dev/test: Redpanda in compose. A `memory` broker adapter runs unit tests. Small self-hosted installs can run with `pg` broker (consumers poll outbox) — same interface (`@wise-biz/contracts` `EventBus` port).

## Envelope (CloudEvents-compatible)

```json
{
  "id": "0192f8c6-…",            // UUIDv7
  "type": "sales.sale.completed",
  "version": 1,
  "source": "api/sales",
  "tenantId": "…",
  "branchId": "…",
  "subject": "sale/0192f8…",
  "time": "2026-10-18T09:21:44.120Z",
  "correlationId": "…",
  "causationId": "…",
  "actor": { "type": "user|device|system|mcp", "id": "…" },
  "data": { }
}
```

Schemas: zod in `@wise-biz/contracts/events`, exported as JSON Schema + AsyncAPI 3 for Django consumers. Breaking change → new `version`; publish both during migration.

## Topics and keys

| Topic | Key | Partitions (start) | Main consumers |
|---|---|---|---|
| `sales` | `tenantId:branchId` | 48 | inventory (after extraction), reporting, loyalty, billing metering, insights, integrations |
| `inventory` | `tenantId:variantId` | 48 | reporting, insights, search, notifications (low stock), storefront cache |
| `catalog` | `tenantId` | 24 | search, sync feed, storefront cache, integrations |
| `pricing` | `tenantId` | 12 | sync feed, storefront cache |
| `customers` | `tenantId:customerId` | 24 | loyalty, search, CRM analytics |
| `payments` | `tenantId` | 24 | sales (online orders), reporting, reconciliation |
| `orders` | `tenantId:orderId` | 24 | inventory, notifications, storefront |
| `devices` | `tenantId` | 12 | notifications, security monitoring |
| `tenancy`, `billing` | `tenantId` | 6 | entitlements cache, notifications |
| `audit` | `tenantId` | 12 | SIEM export, WORM archive |
| `*.dlq` | same | 6 | ops console |

Key choice keeps per-branch or per-entity ordering. Increase partitions before hot tenants appear; never key by a single global value.

## Consumer rules

1. Idempotent by `event.id`.
2. Retry with backoff 3 times, then dead-letter topic with error; DLQ viewer + replay in platform console.
3. Projection consumers can be **rebuilt** from offset 0 (topic retention for `sales`, `inventory`: 30 days + compacted snapshots; long-term rebuild from Postgres).
4. No consumer calls back synchronously into the producer for data it could carry in the event. Events are fat enough for consumers (line items included in `sales.sale.completed`).
5. Batch writes in consumers (`insert … values (…),(…)`), commit offsets after DB commit.

## Core event list (P1)

`identity.user.created`, `tenancy.branch.created`, `devices.device.enrolled`, `devices.device.approved`, `devices.device.revoked`, `catalog.variant.upserted`, `catalog.variant.archived`, `pricing.price.changed`, `pricing.promotion.published`, `inventory.movement.recorded`, `inventory.balance.low`, `inventory.balance.negative`, `inventory.batch.expiring`, `sales.sale.completed`, `sales.sale.voided`, `sales.return.completed`, `sales.shift.opened`, `sales.shift.closed`, `sales.override.approved`, `payments.intent.succeeded`, `payments.refund.succeeded`, `customers.customer.upserted`, `theming.theme.published`.

## Realtime fan-out

Consumers publish compact notices to Redis pub/sub `rt:{tenantId}:{channel}`; `apps/realtime` forwards to subscribed WS/SSE clients after checking the subscriber's permissions. Dashboards receive increments, not full reloads. Throttle per connection (max 4 msgs/s, coalesce).
