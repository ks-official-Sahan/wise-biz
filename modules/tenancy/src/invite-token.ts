import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Invite tokens are never stored: token = base64url(HMAC-SHA256(key, "<tenantId>:<inviteId>")) with
 * key = HMAC-SHA256(INVITE_SECRET, "wb:invite:v1"). A database dump therefore cannot mint an invite.
 * Lives outside domain/ on purpose: domain code may not import node built-ins (depcruise domain-no-node-io).
 */
const KEY_LABEL = "wb:invite:v1";

function deriveKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

export function inviteToken(secret: string, tenantId: string, inviteId: string): string {
  return createHmac("sha256", deriveKey(secret))
    .update(`${tenantId}:${inviteId}`)
    .digest("base64url");
}

/**
 * Constant-time check. `secret` undefined (not configured) fails closed: no token verifies.
 * The compared values are fixed-length digests, so a length mismatch returns early without a timing signal.
 */
export function inviteTokenMatches(
  secret: string | undefined,
  tenantId: string,
  inviteId: string,
  candidate: string,
): boolean {
  if (secret === undefined) return false;
  const expected = Buffer.from(inviteToken(secret, tenantId, inviteId));
  const given = Buffer.from(candidate);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(expected, given);
}
