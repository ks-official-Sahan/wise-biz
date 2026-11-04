import type { ServerClock } from "./clock.ts";
import type { SignedFetch } from "./signed-fetch.ts";

export interface OperatorSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: string;
  readonly permissions?: string[] | "all";
}

/** `POST /v1/devices/pin-login` (online). The offline verifier arrives with the policy snapshot. */
export async function pinLogin(
  signed: SignedFetch,
  userId: string,
  pin: string,
): Promise<OperatorSession> {
  return (await signed<OperatorSession>("POST", "/v1/devices/pin-login", { body: { userId, pin } }))
    .body;
}

export async function pinLogout(signed: SignedFetch): Promise<void> {
  await signed("POST", "/v1/devices/pin-logout");
}

export interface HeartbeatInput {
  appVersion: string;
  unsyncedCount: number;
  oldestUnsyncedAt?: string | null;
  batteryPct?: number | null;
  operatorId?: string | null;
  connection?: "wifi" | "ethernet" | "cellular" | "offline" | "unknown";
}

export interface HeartbeatReply {
  readonly status: "pending" | "active" | "suspended" | "revoked" | "blacklisted";
  readonly serverTime: string;
}

/** Reports health and learns the device status (a revoked terminal wipes itself) and the server time. */
export async function heartbeat(
  signed: SignedFetch,
  clock: ServerClock,
  input: HeartbeatInput,
): Promise<HeartbeatReply> {
  const { body } = await signed<HeartbeatReply>("POST", "/v1/devices/heartbeat", { body: input });
  clock.observe(body.serverTime);
  return body;
}
