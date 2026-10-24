import { DomainError } from "@wise-biz/errors";

/** An invite is usable for this long after it is created (spec P0-08b: 72 h). */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
/** Upper bound on roles and branches one invite may carry (matches tenancy.invites CHECK on role_ids). */
export const MAX_INVITE_ROLES = 20;
export const MAX_INVITE_BRANCHES = 50;
export const EMAIL_MAX = 320;

export type InviteStatus = "pending" | "expired" | "accepted" | "revoked";

export interface InviteState {
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Trim and lower-case. The table CHECK requires lower case, so every write goes through here. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function inviteExpiresAt(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_MS);
}

/** Pure status of an invite row at `now`. Accepted and revoked win over expiry. */
export function inviteStatus(invite: InviteState, now: Date): InviteStatus {
  if (invite.acceptedAt !== null) return "accepted";
  if (invite.revokedAt !== null) return "revoked";
  return invite.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}

/** Removes duplicates, keeps first-seen order. Duplicate ids in one request are a client mistake, not a no-op. */
export function uniqueIds(ids: readonly string[], path: string): string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new DomainError("VALIDATION_FAILED", `${path}: duplicate id`, {
        fieldErrors: [{ path, message: "must not contain duplicates" }],
      });
    }
    seen.add(id);
  }
  return [...ids];
}

/** Every requested id must exist in the tenant. `found` is what the database returned. */
export function assertAllFound(
  requested: readonly string[],
  found: ReadonlySet<string>,
  path: string,
): void {
  const missing = requested.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new DomainError("VALIDATION_FAILED", `${path}: unknown id`, {
      fieldErrors: [{ path, message: "must reference existing items of this tenant" }],
    });
  }
}
