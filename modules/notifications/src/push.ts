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
