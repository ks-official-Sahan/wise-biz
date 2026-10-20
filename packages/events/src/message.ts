/**
 * Transport-neutral event. Maps 1:1 to an outbox row and to a Kafka record:
 * `topic` = topic, `key` = record key (partitioning), `headers` = record headers.
 */
export type EventMessage = Readonly<{
  id: string;
  tenantId: string;
  topic: string;
  key: string;
  type: string;
  version: number;
  payload: unknown;
  headers: Readonly<Record<string, unknown>>;
  createdAt: Date;
}>;

export const eventKey = (type: string, version: number): string => `${type}@v${String(version)}`;

export type Labels = Readonly<Record<string, string>>;
export type MetricName =
  | "processed"
  | "duplicate"
  | "retry"
  | "dead_letter"
  | "relay_batch"
  | "relay_lag_ms"
  | "relay_error"
  | "relay_quarantined"
  | "relay_pruned_outbox"
  | "relay_pruned_processed"
  | "relay_maintenance_error"
  | "relay_loop_error"
  | "dead_letter_failed";
export type OnMetric = (name: MetricName, value: number, labels: Labels) => void;

/** Structural subset of a pino logger (pino's Logger satisfies it). */
export interface BusLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Identity of an event (the outbox primary key). */
export type EventRef = Readonly<{ tenantId: string; id: string }>;

/** Per-event outcome of `EventBus.publish`. `failed` events must be retried by the caller. */
export type PublishResult = Readonly<{
  delivered: readonly EventRef[];
  failed: readonly EventRef[];
}>;
