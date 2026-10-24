import { TenantMemberInvitedV1 } from "../events.ts";
import { inviteToken } from "../invite-token.ts";

import type { MailSender } from "../ports/mail.ts";

/**
 * Structural twin of @wise-biz/events ConsumerDefinition (tenancy does not depend on the events package; the workers
 * pass this object to the bus, which accepts it by shape).
 */
export interface InviteEmailConsumer {
  readonly name: string;
  readonly events: readonly string[];
  readonly maxAttempts: number;
  readonly handle: (event: { readonly payload: unknown }) => Promise<void>;
}

export interface InviteEmailDeps {
  readonly mailer: MailSender;
  /** Console origin (CONSOLE_URL): the link points at its accept page. */
  readonly consoleUrl: string;
  /** INVITE_SECRET: the token is derived here, never stored. */
  readonly inviteSecret: string;
}

export const INVITE_EMAIL_CONSUMER = "tenancy.invite-email";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** The accept link. Only the consumer knows the token; the link never reaches a log line. */
export function inviteAcceptLink(
  consoleUrl: string,
  tenantId: string,
  inviteId: string,
  token: string,
): string {
  const base = consoleUrl.replace(/\/+$/, "");
  const query = new URLSearchParams({ t: tenantId, i: inviteId, k: token });
  return `${base}/invite/accept?${query.toString()}`;
}

/**
 * Sends the invite email for `tenancy.member.invited`. Idempotent per event through the bus (processed_events), so a
 * redelivery after a successful send does not reach this handler again. Failures throw: the bus retries, then
 * dead-letters. The mail body is never logged.
 */
export function createInviteEmailConsumer(deps: InviteEmailDeps): InviteEmailConsumer {
  return {
    name: INVITE_EMAIL_CONSUMER,
    events: [TenantMemberInvitedV1.key],
    maxAttempts: 5,
    handle: async (event) => {
      const parsed = TenantMemberInvitedV1.parse(event.payload);
      const { inviteId, tenantId, email, tenantName, expiresAt } = parsed.data;
      const token = inviteToken(deps.inviteSecret, tenantId, inviteId);
      const link = inviteAcceptLink(deps.consoleUrl, tenantId, inviteId, token);
      const subject = `You are invited to ${tenantName} on wise-biz`;
      const text = [
        `You have been invited to join ${tenantName} on wise-biz.`,
        "",
        `Accept the invite: ${link}`,
        "",
        `The link expires at ${expiresAt}. Sign in with the account for this email address, and verify that address first.`,
        "If you were not expecting this invite, ignore this email.",
      ].join("\n");
      const html = [
        `<p>You have been invited to join <strong>${escapeHtml(tenantName)}</strong> on wise-biz.</p>`,
        `<p><a href="${escapeHtml(link)}">Accept the invite</a></p>`,
        `<p>The link expires at ${escapeHtml(expiresAt)}. Sign in with the account for this email address, and verify that address first.</p>`,
        "<p>If you were not expecting this invite, ignore this email.</p>",
      ].join("");
      await deps.mailer.send({ to: email, subject, text, html });
    },
  };
}
