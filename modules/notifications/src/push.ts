import type { Q } from "./q.ts";

/** One push to one phone. */
export interface PushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  /** An in-app path the app opens on tap. */
  readonly link: string | null;
}

/** What the push service said about a message, in the order sent. */
export type PushResult = { ok: true } | { ok: false; unregistered: boolean };

export interface PushPort {
  readonly send: (messages: readonly PushMessage[]) => Promise<PushResult[]>;
}

const EXPO_URL = "https://exp.host/--/api/v2/push/send";
/** The push service takes at most 100 messages per request. */
const EXPO_BATCH = 100;

/**
 * Expo push service over plain fetch (no SDK). A request that fails as a whole throws, so the bus retries the event; a
 * message the service rejects is reported per message, and `DeviceNotRegistered` marks the token for removal.
 */
export function createExpoPush(
  opts: { fetch?: typeof fetch; accessToken?: string; url?: string } = {},
): PushPort {
  const doFetch = opts.fetch ?? fetch;
  return {
    send: async (messages) => {
      const results: PushResult[] = [];
      for (let i = 0; i < messages.length; i += EXPO_BATCH) {
        const batch = messages.slice(i, i + EXPO_BATCH);
        const res = await doFetch(opts.url ?? EXPO_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            ...(opts.accessToken === undefined
              ? {}
              : { authorization: `Bearer ${opts.accessToken}` }),
          },
          body: JSON.stringify(
            batch.map((m) => ({
              to: m.to,
              title: m.title,
              body: m.body,
              sound: "default",
              data: m.link === null ? {} : { link: m.link },
            })),
          ),
        });
        if (!res.ok) throw new Error(`push service answered ${String(res.status)}`);
        const json = (await res.json()) as {
          data?: { status?: string; details?: { error?: string } }[];
        };
        const tickets = json.data ?? [];
        if (tickets.length !== batch.length)
          throw new Error("push service answered with a wrong count");
        for (const t of tickets) {
          results.push(
            t.status === "ok"
              ? { ok: true }
              : { ok: false, unregistered: t.details?.error === "DeviceNotRegistered" },
          );
        }
      }
      return results;
    },
  };
}

/**
 * Pushes this event's notifications to the phones of the people they are for, once. `pushed_at` records that a
 * notification went out, so a retry after a failure sends only what is still unsent. People with no registered phone
 * are marked done too (nothing to retry). Returns how many messages were handed over.
 */
export async function sendPendingPushes(
  client: Q,
  push: PushPort,
  tenantId: string,
  dedupeKey: string,
): Promise<number> {
  const pending = await client.query<{
    id: string;
    title: string;
    body: string;
    link: string | null;
    token: string | null;
  }>(
    `SELECT n.id, n.title, n.body, n.link, t.token
       FROM notifications.notifications n
       LEFT JOIN notifications.push_tokens t ON t.tenant_id = n.tenant_id AND t.user_id = n.user_id
      WHERE n.tenant_id = $1 AND n.dedupe_key = $2 AND n.pushed_at IS NULL
      ORDER BY n.id, t.token`,
    [tenantId, dedupeKey],
  );
  if (pending.rows.length === 0) return 0;
  const messages: (PushMessage & { notificationId: string })[] = [];
  const ids = new Set<string>();
  for (const r of pending.rows) {
    ids.add(r.id);
    if (r.token !== null)
      messages.push({
        to: r.token,
        title: r.title,
        body: r.body,
        link: r.link,
        notificationId: r.id,
      });
  }
  const results = messages.length === 0 ? [] : await push.send(messages);
  const dead = messages.filter((_, i) => {
    const r = results[i];
    return r !== undefined && !r.ok && r.unregistered;
  });
  for (const m of dead) {
    await client.query(
      `DELETE FROM notifications.push_tokens WHERE tenant_id = $1 AND token = $2`,
      [tenantId, m.to],
    );
  }
  await client.query(
    `UPDATE notifications.notifications SET pushed_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, [...ids]],
  );
  return messages.length;
}
