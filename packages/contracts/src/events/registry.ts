import { z } from "zod";

import { EVENT_TYPE, EventEnvelope } from "./envelope.ts";

function eventSchema<T extends string, V extends number, D extends z.ZodType>(
  type: T,
  version: V,
  data: D,
  key: string,
) {
  return EventEnvelope.extend({
    type: z.literal(type),
    version: z.literal(version),
    data,
  }).meta({ id: key });
}

type EventSchema<T extends string, V extends number, D extends z.ZodType> = ReturnType<
  typeof eventSchema<T, V, D>
>;

export interface EventDefinition<
  T extends string = string,
  V extends number = number,
  D extends z.ZodType = z.ZodType,
> {
  readonly type: T;
  readonly version: V;
  readonly key: string;
  readonly dataSchema: D;
  /** Envelope with `type`/`version` pinned and `data` typed. */
  readonly schema: EventSchema<T, V, D>;
  readonly parse: (input: unknown) => z.output<EventSchema<T, V, D>>;
}

/** Variance-erased view for the registry/listing. */
export interface AnyEventDefinition {
  readonly type: string;
  readonly version: number;
  readonly key: string;
  readonly dataSchema: z.ZodType;
  readonly schema: z.ZodType;
  readonly parse: (input: unknown) => unknown;
}

const registry = new Map<string, AnyEventDefinition>();

export function defineEvent<T extends string, V extends number, D extends z.ZodType>(
  type: T,
  version: V,
  dataSchema: D,
): Readonly<EventDefinition<T, V, D>> {
  if (!EVENT_TYPE.test(type)) throw new Error(`invalid event type: ${type}`);
  if (!Number.isInteger(version) || version < 1)
    throw new Error("invalid event version: " + String(version));
  const key = `${type}@v${String(version)}`;
  if (registry.has(key)) throw new Error(`duplicate event definition: ${key}`);
  const schema = eventSchema(type, version, dataSchema, key);
  const def = Object.freeze({
    type,
    version,
    key,
    dataSchema,
    schema,
    parse: (input: unknown) => schema.parse(input),
  });
  registry.set(key, def);
  return def;
}

/** All registered events, sorted by key. */
export function listEvents(): readonly AnyEventDefinition[] {
  return [...registry.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
