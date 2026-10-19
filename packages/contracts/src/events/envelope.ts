import { z } from "zod";

import { Timestamp, Uuid7 } from "../common/index.ts";

/** `<module>.<entity>.<verb>`, e.g. `sales.sale.completed`. */
export const EVENT_TYPE = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export const Actor = z.object({
  type: z.enum(["user", "device", "system", "mcp"]),
  id: z.string().min(1),
});

/** Base envelope (CloudEvents-compatible). See docs/architecture/events.md. */
export const EventEnvelope = z
  .object({
    id: Uuid7,
    type: z.string().regex(EVENT_TYPE),
    version: z.number().int().min(1),
    source: z.string().min(1),
    tenantId: Uuid7,
    branchId: Uuid7.nullish(),
    subject: z.string().min(1),
    time: Timestamp,
    correlationId: z.string().min(1),
    causationId: z.string().min(1).optional(),
    actor: Actor,
    data: z.unknown(),
  })
  .meta({ id: "EventEnvelope" });
