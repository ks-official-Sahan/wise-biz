import { z } from "zod";

import { notify } from "./notify.ts";

import type { Kind } from "./kinds.ts";
import type { PoolClient } from "pg";

export const NOTIFICATIONS_CONSUMER = "notifications.fanout";

const EVENTS = [
  "inventory.balance.low@v1",
  "inventory.batch.expiring@v1",
  "devices.heartbeat.missed@v1",
] as const;

export interface NotificationsDeps {
  /** Active people who hold a permission (the owner always counts). Built from tenancy at the composition root. */
  readonly holders: (
    client: PoolClient,
    tenantId: string,
    permission: string,
    scope: { locationIds?: readonly string[]; branchIds?: readonly string[] },
  ) => Promise<string[]>;
}

export interface NotificationsConsumer {
  readonly name: string;
  readonly events: readonly string[];
  readonly maxAttempts: number;
  readonly handle: (
    event: {
      readonly id: string;
      readonly tenantId: string;
      readonly type: string;
      readonly payload: unknown;
    },
    ctx: { readonly client: PoolClient },
  ) => Promise<void>;
}

/** The bus hands over the whole event envelope; the business fields are under data. */
const envelope = <T extends z.ZodType>(data: T) => z.object({ data });
const Low = z.object({ locationId: z.string(), qty: z.coerce.string(), minQty: z.coerce.string() });
const Missed = z.object({
  branchId: z.string(),
  name: z.string(),
  silentMinutes: z.number(),
});
const Expiring = z.object({
  lotCode: z.string().nullable(),
  expiresOn: z.string(),
  stock: z.array(z.object({ locationId: z.string() })),
});

/**
 * Turns stock events into in-app notifications for the people who can act on them. The notification links to the stock
 * screen, never to a URL outside the app.
 */
export function createNotificationsConsumer(deps: NotificationsDeps): NotificationsConsumer {
  const tell = async (
    client: PoolClient,
    tenantId: string,
    kind: Kind,
    permission: string,
    scope: { locationIds?: readonly string[]; branchIds?: readonly string[] },
    title: string,
    body: string,
    eventId: string,
    link = "/stock",
  ): Promise<void> => {
    const people = await deps.holders(client, tenantId, permission, scope);
    await notify(client, tenantId, people, {
      kind,
      title,
      body,
      link,
      dedupeKey: eventId,
    });
  };

  return {
    name: NOTIFICATIONS_CONSUMER,
    events: EVENTS,
    maxAttempts: 5,
    handle: async (event, ctx) => {
      if (event.type === "inventory.balance.low") {
        const p = envelope(Low).parse(event.payload).data;
        await tell(
          ctx.client,
          event.tenantId,
          "low_stock",
          "inventory:read",
          { locationIds: [p.locationId] },
          "Stock is running low",
          `On hand is ${p.qty}, below the minimum of ${p.minQty}. Reorder soon.`,
          event.id,
        );
      } else if (event.type === "inventory.batch.expiring") {
        const p = envelope(Expiring).parse(event.payload).data;
        const lot = p.lotCode === null ? "A batch" : `Batch ${p.lotCode}`;
        await tell(
          ctx.client,
          event.tenantId,
          "expiring",
          "inventory:read",
          { locationIds: p.stock.map((x) => x.locationId) },
          "Stock is about to expire",
          `${lot} expires on ${p.expiresOn}. Sell it first or mark it down.`,
          event.id,
        );
      } else if (event.type === "devices.heartbeat.missed") {
        const p = envelope(Missed).parse(event.payload).data;
        await tell(
          ctx.client,
          event.tenantId,
          "device_offline",
          "devices:read",
          { branchIds: [p.branchId] },
          `${p.name} went offline`,
          `No signal from this terminal for ${String(p.silentMinutes)} minutes. Check its power and network.`,
          event.id,
          "/devices",
        );
      }
    },
  };
}
