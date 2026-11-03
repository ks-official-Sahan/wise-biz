import { KINDS } from "./kinds.ts";

import type { Kind } from "./kinds.ts";
import type { Q } from "./q.ts";

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

interface Raw {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  created_at: Date;
  read_at: Date | null;
}

const toRow = (r: Raw): NotificationRow => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  link: r.link,
  createdAt: r.created_at.toISOString(),
  readAt: r.read_at?.toISOString() ?? null,
});

/** Newest first, keyset on the UUIDv7 id (time-ordered). Only the caller's own rows. */
export async function list(
  q: Q,
  tenantId: string,
  userId: string,
  opts: { unread: boolean; limit: number; after?: string | undefined },
): Promise<{ notifications: NotificationRow[]; next: string | null }> {
  const { rows } = await q.query<Raw>(
    `SELECT id, kind, title, body, link, created_at, read_at
       FROM notifications.notifications
      WHERE tenant_id = $1 AND user_id = $2
        AND ($3::boolean = false OR read_at IS NULL)
        AND ($4::uuid IS NULL OR id < $4::uuid)
      ORDER BY id DESC
      LIMIT $5`,
    [tenantId, userId, opts.unread, opts.after ?? null, opts.limit + 1],
  );
  const page = rows.slice(0, opts.limit);
  return {
    notifications: page.map(toRow),
    next: rows.length > opts.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function unreadCount(q: Q, tenantId: string, userId: string): Promise<number> {
  const { rows } = await q.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM notifications.notifications
      WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
    [tenantId, userId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Marks the caller's own notifications read (already-read rows are left alone). Returns how many changed. */
export async function markRead(
  q: Q,
  tenantId: string,
  userId: string,
  target: { ids: readonly string[] } | { all: true },
): Promise<number> {
  const ids = "ids" in target ? [...target.ids] : null;
  const res = await q.query(
    `UPDATE notifications.notifications SET read_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL
        AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
    [tenantId, userId, ids],
  );
  return res.rowCount ?? 0;
}

export interface Preference {
  kind: Kind;
  label: string;
  inApp: boolean;
  email: boolean;
}

/** Every kind, with the person's choice or the default (in-app on, email off). */
export async function preferences(q: Q, tenantId: string, userId: string): Promise<Preference[]> {
  const { rows } = await q.query<{ kind: string; in_app: boolean; email: boolean }>(
    `SELECT kind, in_app, email FROM notifications.preferences WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  const mine = new Map(rows.map((r) => [r.kind, r]));
  return KINDS.map((k) => ({
    kind: k.kind,
    label: k.label,
    inApp: mine.get(k.kind)?.in_app ?? true,
    email: mine.get(k.kind)?.email ?? false,
  }));
}

export async function setPreferences(
  q: Q,
  tenantId: string,
  userId: string,
  items: readonly { kind: Kind; inApp: boolean; email: boolean }[],
  /** The caller's verified address, kept beside every kind they turned email on for. */
  emailTo: string | null,
): Promise<void> {
  // Last one wins when a kind repeats; sorted so concurrent saves lock rows in the same order.
  const byKind = new Map(items.map((i) => [i.kind, i]));
  const sorted = [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
  await q.query(
    `INSERT INTO notifications.preferences (tenant_id, user_id, kind, in_app, email, email_to)
     SELECT $1, $2, x.kind, x.in_app, x.email, CASE WHEN x.email THEN $4 END
       FROM jsonb_to_recordset($3::jsonb) AS x(kind text, in_app boolean, email boolean)
     ON CONFLICT (tenant_id, user_id, kind)
       DO UPDATE SET in_app = EXCLUDED.in_app, email = EXCLUDED.email, email_to = EXCLUDED.email_to,
                     updated_at = now()`,
    [
      tenantId,
      userId,
      JSON.stringify(sorted.map((i) => ({ kind: i.kind, in_app: i.inApp, email: i.email }))),
      emailTo,
    ],
  );
}

export async function addPushToken(
  q: Q,
  tenantId: string,
  userId: string,
  token: string,
  platform: "ios" | "android",
): Promise<void> {
  // A phone belongs to whoever signed in last: drop the token from anyone else so their pushes stop reaching it.
  await q.query(
    `DELETE FROM notifications.push_tokens WHERE tenant_id = $1 AND token = $3 AND user_id <> $2`,
    [tenantId, userId, token],
  );
  await q.query(
    `INSERT INTO notifications.push_tokens (tenant_id, user_id, token, platform)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [tenantId, userId, token, platform],
  );
}

export async function removePushToken(
  q: Q,
  tenantId: string,
  userId: string,
  token: string,
): Promise<void> {
  await q.query(
    `DELETE FROM notifications.push_tokens WHERE tenant_id = $1 AND user_id = $2 AND token = $3`,
    [tenantId, userId, token],
  );
}
