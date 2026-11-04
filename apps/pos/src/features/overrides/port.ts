import type { Approval } from "../../state/slices.ts";

export type VerifyResult =
  | { readonly ok: true; readonly approverId: string }
  | { readonly ok: false; readonly reason: "invalid" | "self" | "unavailable" };

/**
 * Checks a supervisor's PIN for one permission. The terminal never learns the PIN of anyone: the check is the server's
 * (online) or the policy snapshot's offline verifier. Neither exists yet (follow-up: `POST /v1/devices/override-verify`
 * and the policy-snapshot producer), so the default port answers `unavailable` and the sheet says so plainly.
 */
export interface OverridePort {
  readonly verify: (input: {
    readonly approverUserId: string;
    readonly pin: string;
    readonly permission: string;
    readonly requesterId: string;
  }) => Promise<VerifyResult>;
}

export const unavailableOverridePort: OverridePort = {
  verify: () => Promise.resolve({ ok: false, reason: "unavailable" }),
};

export interface OverrideRequest {
  readonly permission: string;
  readonly requesterId: string;
  readonly subjectId: string;
  readonly reason: string;
}

/** Runs the check and, on success, produces the approval the cart keeps for the sale command. */
export async function requestApproval(
  port: OverridePort,
  req: OverrideRequest & { readonly approverUserId: string; readonly pin: string },
  newId: () => string,
  now: () => number,
): Promise<
  | { ok: true; approval: Approval }
  | { ok: false; reason: "invalid" | "self" | "unavailable" | "no_reason" }
> {
  if (req.reason.trim() === "") return { ok: false, reason: "no_reason" };
  if (req.approverUserId === req.requesterId) return { ok: false, reason: "self" };
  const r = await port.verify({
    approverUserId: req.approverUserId,
    pin: req.pin,
    permission: req.permission,
    requesterId: req.requesterId,
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  return {
    ok: true,
    approval: {
      id: newId(),
      permission: req.permission,
      approverId: r.approverId,
      requesterId: req.requesterId,
      reason: req.reason.trim(),
      subjectId: req.subjectId,
      at: now(),
    },
  };
}
