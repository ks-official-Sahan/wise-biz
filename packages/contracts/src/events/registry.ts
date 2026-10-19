import { z } from "zod";

import { EVENT_TYPE, EventEnvelope } from "./envelope.ts";

const registry = new Map<string, EventDefinition>();

export interface EventDefinition<D extends z.ZodType = z.ZodType> {
  readonly type: string;
  readonly version: number;
  readonly key: string;
  readonly dataSchema: D;
  /** Envelope with `type`/`version` pinned and `data` typed. */
  readonly schema: z.ZodType<Omit<z.infer<typeof EventEnvelope>, "data"> & { data: z.infer<D> }>;
  readonly parse: (input: unknown) => Omit<z.infer<typeof EventEnvelope>, "data"> & {
    data: z.infer<D>;
  };
}

export function defineEvent<D extends z.ZodType>(
  type: string,
  version: number,
  dataSchema: D,
): Readonly<EventDefinition<D>> {
  if (!EVENT_TYPE.test(type)) throw new Error(`invalid event type: ${type}`);
  if (!Number.isInteger(version) || version < 1)
    throw new Error("invalid event version: " + String(version));
  const key = `${type}@v${String(version)}`;
  if (registry.has(key)) throw new Error(`duplicate event definition: ${key}`);
  const schema = EventEnvelope.extend({
    type: z.literal(type),
    version: z.literal(version),
    data: dataSchema,
  }).meta({ id: key });
  const def = Object.freeze({
    type,
    version,
    key,
    dataSchema,
    schema,
    parse: (input: unknown) => schema.parse(input),
  }) as unknown as Readonly<EventDefinition<D>>;
  registry.set(key, def);
  return def;
}

/** All registered events, sorted by key. */
export function listEvents(): readonly EventDefinition[] {
  return [...registry.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
