import type { Kind } from "./kinds.ts";
import type { Q } from "./q.ts";

export interface Message {
  readonly kind: Kind;
  readonly title: string;
  readonly body: string;
  readonly link?: string;
  /** The event (or job run) behind it: redelivery does not tell the same person twice. */
  readonly dedupeKey: string;
}

/**
 * Tells each person once, unless they turned the kind off. Runs in the caller's tenant transaction. Returns how many
 * people were told. Safe to repeat: the unique (user, dedupe key) index drops the repeat.
 */
export async function notify(
  client: Q,
  tenantId: string,
  userIds: readonly string[],
  msg: Message,
): Promise<number> {
  if (userIds.length === 0) return 0;
  const res = await client.query(
    `INSERT INTO notifications.notifications (tenant_id, user_id, kind, title, body, link, dedupe_key)
     SELECT $1, u, $3, $4, $5, $6, $7
       FROM unnest($2::uuid[]) AS u
      WHERE NOT EXISTS (SELECT 1 FROM notifications.preferences p
                         WHERE p.tenant_id = $1 AND p.user_id = u AND p.kind = $3 AND p.in_app = false)
     ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [tenantId, [...userIds], msg.kind, msg.title, msg.body, msg.link ?? null, msg.dedupeKey],
  );
  return res.rowCount ?? 0;
}

/** Where emails go out and what the link in them points at (the console origin). */
export interface MailPort {
  readonly send: (msg: { to: string; subject: string; text: string }) => Promise<void>;
  readonly consoleUrl: string;
}
