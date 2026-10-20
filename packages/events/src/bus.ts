import type { ConsumerDefinition } from "./consumer.ts";
import type { EventMessage } from "./message.ts";

/**
 * Port. Kafka-compatible: `publish` = produce (topic/key/headers), `subscribe` = consumer group
 * `consumer.name`. Delivery is at-least-once; consumers dedupe by (consumer, event id).
 */
export interface EventBus {
  publish(batch: readonly EventMessage[]): Promise<void>;
  subscribe(consumer: ConsumerDefinition): void;
  start?(): Promise<void>;
  stop(): Promise<void>;
}
