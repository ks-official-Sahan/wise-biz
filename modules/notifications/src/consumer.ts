import { z } from "zod";

import { notify, sendPendingEmails } from "./notify.ts";
import { sendPendingPushes } from "./push.ts";

import type { Kind } from "./kinds.ts";
import type { MailPort } from "./notify.ts";
import type { PushPort } from "./push.ts";
import type { PoolClient } from "pg";

export const NOTIFICATIONS_CONSUMER = "notifications.fanout";

const EVENTS = [
  "inventory.balance.low@v1",
  "inventory.batch.expiring@v1",
  "devices.heartbeat.missed@v1",
  "reporting.export.ready@v1",
  "reporting.digest.ready@v1",
] as const;

export interface NotificationsDeps {
  /** Omit to keep notifications in the app only (tests, and deployments without a mailer). */
  readonly mail?: MailPort;
  /** Omit to skip phone push (tests, and deployments without one). */
  readonly push?: PushPort;
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
const Digest = z.object({
  businessDate: z.string(),
  totals: z.array(
    z.object({
      currency: z.string(),
      salesCount: z.number(),
      netMinor: z.number(),
      voidsCount: z.number(),
      returnsCount: z.number(),
    }),
  ),
});

/** 12345 + USD -> "$123.45"; the minor-unit digits come from the currency itself (JPY 0, KWD 3). */
function money(minor: number, currency: string): string {
  const f = new Intl.NumberFormat("en", { style: "currency", currency });
  const digits = f.resolvedOptions().maximumFractionDigits ?? 2;
  return f.format(minor / 10 ** digits);
}
const ExportReady = z.object({
  exportId: z.string(),
  requestedBy: z.string(),
  rowCount: z.number(),
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
  /** Email and phone push for the notifications this event stored; each remembers what it already sent. */
  const deliver = async (client: PoolClient, tenantId: string, eventId: string): Promise<void> => {
    if (deps.mail !== undefined) await sendPendingEmails(client, deps.mail, tenantId, eventId);
    if (deps.push !== undefined) await sendPendingPushes(client, deps.push, tenantId, eventId);
  };

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
    await deliver(client, tenantId, eventId);
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
      } else if (event.type === "reporting.export.ready") {
        // Only the person who asked is told, not everyone who can read reports.
        const p = envelope(ExportReady).parse(event.payload).data;
        await notify(ctx.client, event.tenantId, [p.requestedBy], {
          kind: "export_ready",
          title: "Your export is ready",
          body: `Sale lines: ${String(p.rowCount)} rows. Download it from Reports; it stays available for 7 days.`,
          link: "/reports",
          dedupeKey: event.id,
        });
        await deliver(ctx.client, event.tenantId, event.id);
      } else if (event.type === "reporting.digest.ready") {
        const p = envelope(Digest).parse(event.payload).data;
        const lines = p.totals.map(
          (t) => `${String(t.salesCount)} sales, ${money(t.netMinor, t.currency)} net of returns`,
        );
        await tell(
          ctx.client,
          event.tenantId,
          "daily_summary",
          "reporting:read",
          {},
          `Sales on ${p.businessDate}`,
          `${lines.join("; ")}. Open Reports for the detail.`,
          event.id,
          "/reports",
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
