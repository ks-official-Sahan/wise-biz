import { z } from "zod";

import { notify } from "./notify.ts";

import type { Kind } from "./kinds.ts";
import type { PoolClient } from "pg";

export const NOTIFICATIONS_CONSUMER = "notifications.fanout";

const EVENTS = ["inventory.balance.low@v1", "inventory.batch.expiring@v1"] as const;

export interface NotificationsDeps {
  /** Active people who hold a permission (the owner always counts). Built from tenancy at the composition root. */
  readonly holders: (
    client: PoolClient,
    tenantId: string,
    permission: string,
    locationIds: readonly string[],
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

const Low = z.object({ locationId: z.string(), qty: z.coerce.string(), minQty: z.coerce.string() });
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
    locationIds: readonly string[],
    title: string,
    body: string,
    eventId: string,
  ): Promise<void> => {
    const people = await deps.holders(client, tenantId, permission, locationIds);
    await notify(client, tenantId, people, {
      kind,
      title,
      body,
      link: "/stock",
      dedupeKey: eventId,
    });
  };

  return {
    name: NOTIFICATIONS_CONSUMER,
    events: EVENTS,
    maxAttempts: 5,
    handle: async (event, ctx) => {
      if (event.type === "inventory.balance.low") {
        const p = Low.parse(event.payload);
        await tell(
          ctx.client,
          event.tenantId,
          "low_stock",
          "inventory:read",
          [p.locationId],
          "Stock is running low",
          `On hand is ${p.qty}, below the minimum of ${p.minQty}. Reorder soon.`,
          event.id,
        );
      } else if (event.type === "inventory.batch.expiring") {
        const p = Expiring.parse(event.payload);
        const lot = p.lotCode === null ? "A batch" : `Batch ${p.lotCode}`;
        await tell(
          ctx.client,
          event.tenantId,
          "expiring",
          "inventory:read",
          p.stock.map((x) => x.locationId),
          "Stock is about to expire",
          `${lot} expires on ${p.expiresOn}. Sell it first or mark it down.`,
          event.id,
        );
      }
    },
  };
}
