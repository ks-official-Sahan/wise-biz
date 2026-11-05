import { withTenantTx } from "@wise-biz/db";

import type { MailPort } from "./notify.ts";
import type { PushMessage, PushPort } from "./push.ts";
import type { Q } from "./q.ts";
import type pg from "pg";

/** Stage 1, in the event's transaction: flag what needs an email or a phone push. Runs once per notification. */
export async function markDeliveries(
  client: Q,
  tenantId: string,
  dedupeKey: string,
  channels: { email?: boolean | undefined; push?: boolean | undefined },
): Promise<void> {
  await client.query(
    `UPDATE notifications.notifications n SET
       delivery_marked_at = now(),
       email_pending = $3 AND EXISTS (
         SELECT 1 FROM notifications.preferences p
          WHERE p.tenant_id = n.tenant_id AND p.user_id = n.user_id AND p.kind = n.kind
            AND p.email AND p.email_to IS NOT NULL),
       push_pending = $4 AND EXISTS (
         SELECT 1 FROM notifications.push_tokens t
          WHERE t.tenant_id = n.tenant_id AND t.user_id = n.user_id)
     WHERE n.tenant_id = $1 AND n.dedupe_key = $2 AND n.delivery_marked_at IS NULL`,
    [tenantId, dedupeKey, channels.email === true, channels.push === true],
  );
}

export interface DeliveryDeps {
  readonly pool: pg.Pool;
  readonly mail?: MailPort | undefined;
  readonly push?: PushPort | undefined;
  /** A claimed row is not claimed again until this long has passed (covers a crash between send and mark). */
  readonly leaseMs?: number;
  /** Rows claimed per business per pass. */
  readonly batch?: number;
  /** After this many claims a row is given up on, so a poisoned address cannot be retried forever. */
  readonly maxAttempts?: number;
  /** A single email or push send gets this long before it counts as failed (the message may still arrive). */
  readonly sendTimeoutMs?: number;
  readonly onError?: (
    err: unknown,
    tenantId: string,
    notificationId: string,
    channel: "email" | "push",
  ) => void;
}

interface Claimed {
  id: string;
  title: string;
  body: string;
  link: string | null;
  email_pending: boolean;
  push_pending: boolean;
  email_to: string | null;
  tokens: string[];
}

/** Businesses with due rows, the one waiting longest first (ids are UUIDv7, so the smallest id is the oldest row). */
const TENANTS_SQL = `SELECT tenant_id FROM notifications.notifications
  WHERE ((email_pending AND $1) OR (push_pending AND $2))
    AND (delivery_lease_until IS NULL OR delivery_lease_until < now())
  GROUP BY tenant_id ORDER BY min(id::text) LIMIT 50`;

/** Messages per push request the service accepts; a group of notifications is sent and marked together up to this. */
const PUSH_GROUP = 100;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`send timed out after ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer);
  });
}

/** Claim = lease + attempt count in one statement. A row past its attempts stops being pending (given up on). */
const CLAIM_SQL = `
  WITH due AS (
    SELECT id FROM notifications.notifications
     WHERE tenant_id = $1 AND ((email_pending AND $5) OR (push_pending AND $6))
       AND (delivery_lease_until IS NULL OR delivery_lease_until < now())
     ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED),
  claimed AS (
    UPDATE notifications.notifications n SET
        delivery_lease_until = now() + ($3::int * interval '1 millisecond'),
        delivery_attempts = n.delivery_attempts + 1,
        email_pending = n.email_pending AND n.delivery_attempts + 1 <= $4,
        push_pending = n.push_pending AND n.delivery_attempts + 1 <= $4
      FROM due WHERE n.tenant_id = $1 AND n.id = due.id
      RETURNING n.id, n.user_id, n.kind, n.title, n.body, n.link, n.email_pending, n.push_pending)
  SELECT c.id, c.title, c.body, c.link, c.email_pending, c.push_pending,
         (SELECT p.email_to FROM notifications.preferences p
           WHERE p.tenant_id = $1 AND p.user_id = c.user_id AND p.kind = c.kind AND p.email) AS email_to,
         COALESCE((SELECT array_agg(t.token ORDER BY t.token) FROM notifications.push_tokens t
                    WHERE t.tenant_id = $1 AND t.user_id = c.user_id), '{}') AS tokens
    FROM claimed c ORDER BY c.id`;

/**
 * Stage 2: sends the flagged emails and pushes. Safe to run on several workers at once (rows are claimed with SKIP
 * LOCKED and a lease). Nothing is sent inside a transaction, and each row is marked as soon as its own send succeeds, so
 * the worst case is one repeat of one message after a crash, never a repeat of a whole batch. Returns how many
 * messages went out.
 */
export async function runDeliveries(deps: DeliveryDeps): Promise<number> {
  const tenants = await deps.pool.query<{ tenant_id: string }>(TENANTS_SQL, [
    deps.mail !== undefined,
    deps.push !== undefined,
  ]);
  let sent = 0;
  for (const { tenant_id: tenantId } of tenants.rows) sent += await deliverTenant(deps, tenantId);
  return sent;
}

async function deliverTenant(deps: DeliveryDeps, tenantId: string): Promise<number> {
  const scope = { tenantId, requestId: "notifications-delivery" };
  const leaseMs = deps.leaseMs ?? 120_000;
  const sendMs = deps.sendTimeoutMs ?? 10_000;
  const claimedAt = Date.now();
  const claimed = await withTenantTx(
    deps.pool,
    scope,
    async (tx) =>
      (
        await tx.query<Claimed>(CLAIM_SQL, [
          tenantId,
          deps.batch ?? 50,
          leaseMs,
          deps.maxAttempts ?? 5,
          deps.mail !== undefined,
          deps.push !== undefined,
        ])
      ).rows,
  );
  // The lease covers the whole batch. Stop sending once a send could outlive it: the rest stay pending and are claimed
  // again after the lease, so another worker never sends a row this one is still sending.
  const budget = Math.max(leaseMs - sendMs, sendMs);
  const hasTime = (): boolean => Date.now() - claimedAt < budget;
  let sent = 0;
  const markEmail = (id: string) =>
    withTenantTx(deps.pool, scope, (tx) =>
      tx.query(
        "UPDATE notifications.notifications SET email_pending = false, emailed_at = now() WHERE tenant_id = $1 AND id = $2",
        [tenantId, id],
      ),
    );
  const markPush = (ids: readonly string[]) =>
    withTenantTx(deps.pool, scope, (tx) =>
      tx.query(
        "UPDATE notifications.notifications SET push_pending = false, pushed_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
        [tenantId, ids],
      ),
    );

  for (const n of claimed) {
    // No mail port: leave the row pending (this worker cannot send it); never mark an email done that was not sent.
    if (!n.email_pending || deps.mail === undefined) continue;
    if (n.email_to === null) {
      // The address was cleared since: nothing to send to, done, not retried.
      await markEmail(n.id);
      continue;
    }
    if (!hasTime()) break;
    const where = n.link === null ? "" : `\n\nOpen it: ${deps.mail.consoleUrl}${n.link}`;
    try {
      await withTimeout(
        deps.mail.send({
          to: n.email_to,
          subject: n.title,
          text: `${n.body}${where}\n\nChange what you are emailed about in the console under Notifications.`,
        }),
        sendMs,
      );
      await markEmail(n.id);
      sent++;
    } catch (err) {
      deps.onError?.(err, tenantId, n.id, "email");
    }
  }

  if (deps.push === undefined) return sent;
  const push = deps.push;
  // Groups of whole notifications up to one push request of messages, each sent and then marked on its own: a failure in
  // a later group leaves only that group pending, never the groups that already reached phones.
  const groups: Claimed[][] = [];
  let size = 0;
  for (const n of claimed) {
    if (!n.push_pending) continue;
    if (groups.length === 0 || size + n.tokens.length > PUSH_GROUP) {
      groups.push([]);
      size = 0;
    }
    groups[groups.length - 1]?.push(n);
    size += n.tokens.length;
  }
  for (const group of groups) {
    if (!hasTime()) break;
    const messages: PushMessage[] = group.flatMap((n) =>
      n.tokens.map((token) => ({ to: token, title: n.title, body: n.body, link: n.link })),
    );
    try {
      const results = messages.length === 0 ? [] : await withTimeout(push.send(messages), sendMs);
      const dead = messages.filter((_, i) => {
        const r = results[i];
        return r !== undefined && !r.ok && r.unregistered;
      });
      if (dead.length > 0)
        await withTenantTx(deps.pool, scope, (tx) =>
          tx.query(
            "DELETE FROM notifications.push_tokens WHERE tenant_id = $1 AND token = ANY($2::text[])",
            [tenantId, dead.map((m) => m.to)],
          ),
        );
      await markPush(group.map((n) => n.id));
      sent += messages.length;
    } catch (err) {
      for (const n of group) deps.onError?.(err, tenantId, n.id, "push");
    }
  }
  return sent;
}
