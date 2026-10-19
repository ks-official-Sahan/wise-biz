# ADR 0006: Transactional outbox, Kafka as the bus

Status: accepted · 2026-10-18

## Decision
Every state change writes an outbox row in the same transaction. A relay publishes to Kafka (Redpanda in dev). An `EventBus` port has three adapters: `memory` (tests), `pg` (small self-hosted installs, consumers poll outbox), `kafka` (production). Consumers are idempotent by event id.

## Consequences
No dual-write inconsistency; Kafka outages delay side effects but never lose them; Django/AI services integrate by consuming topics; Debezium CDC is the upgrade path for very high volume.
