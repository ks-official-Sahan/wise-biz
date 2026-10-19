# P2-01 · Kafka in production

Effort: **H** · Needs: P1-16 · Gate: confirm plan (managed Kafka/Redpanda provider choice)
Read: `docs/architecture/events.md`, `docs/adr/0006-outbox-kafka.md`
Libraries: KafkaJS successor or `@confluentinc/kafka-javascript` (check maintenance), Redpanda
Skills: `kafka-stream-processing`, `ecc:backend-patterns`

## Goal
Switch the event bus from the `pg` adapter to Kafka without changing any producer or consumer code, and give ops visibility of lag and dead letters.

## Scope
- `kafka` adapter for `EventBus`; relay publishes outbox → topics/keys per events.md (idempotent producer, acks=all); consumer groups per consumer name; offsets committed after DB commit.
- Topic provisioning as code (partitions, retention, compaction where noted), DLQ topics.
- Trace context propagated in headers; metrics: consumer lag, relay lag, DLQ size; alerts.
- Platform console page: DLQ viewer with replay (permission-gated, audited).
- Feature flag to switch adapters per environment; dual-run test in staging.

## Delegation
wb-researcher (haiku) client lib → wb-builder (sonnet) `packages/events/src/kafka/**`, relay → wb-scaffolder (haiku) topic config → wb-ui-builder (sonnet) DLQ page → wb-tester (haiku) integration with Redpanda Testcontainer.

## Acceptance
- Full test suite passes with `EVENT_BUS=kafka`.
- Kill a consumer mid-batch: no loss, no double effects.
- Staging soak 24 h at 2× pilot traffic: lag < 5 s p95.

## Review
`ecc:performance-optimizer`, `ecc:silent-failure-hunter`
