# @wise-biz/events

`EventBus` port + adapters. Delivery is at-least-once; consumers are idempotent by `(consumer, event.id)`.

- `createMemoryBus()` - in-process, for unit tests. Same retry, idempotency and dead-letter semantics.
- `createPgBus({ pool, logger })` - pool must be `wb_worker`. Per (event, consumer): `BEGIN` -> `recordProcessed`
  (false = duplicate, skip) -> handler (same tx via `ctx.client`) -> `COMMIT`. Throw -> `ROLLBACK`, retry with
  exponential backoff (100 ms x2, jittered, `maxAttempts` total, default 3), then `infra.dead_letters`
  (message only, 1000 chars) and carry on with the rest of the batch. If the dead-letter write itself fails,
  `publish` throws so the relay retries the batch (idempotency makes that safe).
- Metrics: `onMetric(name, value, labels)` for `processed | duplicate | retry | dead_letter` (+ relay metrics).

## Writing a consumer

```ts
export const loyalty = defineConsumer({
  name: "loyalty.points",
  events: ["sales.sale.completed@v1"], // or "sales.sale.completed@*"
  handle: async (event, { client }) => {
    /* writes on `client` commit atomically with the processed marker */
  },
});
```

## Kafka adapter (P2, not built)

`EventMessage` already carries `topic`, `key` (partition key) and `headers`.

- `publish(batch)`: `producer.send` grouped by topic, `{ key, value: JSON(payload), headers: { id, tenantId, type, version, ...headers } }`,
  idempotent producer, `acks=all`. Resolve only after the broker acks (the relay then marks the outbox rows published).
- `subscribe(consumer)`: one consumer group per `consumer.name`, subscribe to the topics of its `events`. Per message:
  match `type@version`, run the same `deliver()` retry loop and DB tx (`recordProcessed` + handler), commit the offset
  after the DB commit; on exhaustion write `dead_letters` (and optionally `<topic>.dlq`) and commit the offset.
- `start()` connects producer and consumers; `stop()` drains in-flight messages and disconnects.
