import type { ConsumerDefinition } from "./consumer.ts";
import type { EventMessage, PublishResult } from "./message.ts";

/**
 * Port. Kafka-compatible: `publish` = produce (topic/key/headers), `subscribe` = consumer group
 * `consumer.name`. Delivery is at-least-once; consumers dedupe by (consumer, event id).
 */
export interface EventBus {
  /**
   * Resolves with a per-event outcome. `delivered` = every matching consumer handled it or it was
   * dead-lettered; `failed` = it could not be completed (e.g. the dead-letter write failed) and must be
   * redelivered. Rejects only when the whole bus cannot work (stopped).
   */
  publish(batch: readonly EventMessage[]): Promise<PublishResult>;
  subscribe(consumer: ConsumerDefinition): void;
  start?(): Promise<void>;
  stop(): Promise<void>;
}
