import type { BusLogger, EventMessage } from "./message.ts";
import type { PoolClient } from "pg";

export type ConsumerContext = Readonly<{
  /** Inside the consumer transaction (pg adapter). The memory adapter has no database: using it throws. */
  client: PoolClient;
  logger: BusLogger;
  /** 1-based delivery attempt. */
  attempt: number;
}>;

export type ConsumerEvent = EventMessage;

export interface ConsumerDefinition {
  readonly name: string;
  /** `"type@vN"` or `"type@*"`. */
  readonly events: readonly string[];
  readonly handle: (event: ConsumerEvent, ctx: ConsumerContext) => Promise<void>;
  readonly maxAttempts: number;
}

const NAME = /^[a-z][a-z0-9_.-]*$/;
const PATTERN = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*@(v[1-9][0-9]*|\*)$/;

export function defineConsumer(input: {
  name: string;
  events: readonly string[];
  handle: ConsumerDefinition["handle"];
  maxAttempts?: number;
}): Readonly<ConsumerDefinition> {
  if (!NAME.test(input.name)) throw new Error(`invalid consumer name: ${input.name}`);
  if (input.events.length === 0)
    throw new Error(`consumer ${input.name}: events must not be empty`);
  for (const e of input.events) {
    if (!PATTERN.test(e)) throw new Error(`consumer ${input.name}: invalid event pattern ${e}`);
  }
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    throw new Error(`consumer ${input.name}: maxAttempts must be an integer >= 1`);
  return Object.freeze({
    name: input.name,
    events: Object.freeze([...input.events]),
    handle: input.handle,
    maxAttempts,
  });
}
