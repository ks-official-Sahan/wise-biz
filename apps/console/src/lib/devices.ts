"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "./api.ts";
import { STALE } from "./queries.ts";

export type DeviceStatus = "pending" | "active" | "suspended" | "revoked" | "blacklisted";
export interface Device {
  readonly deviceId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly name: string;
  readonly platform: "android" | "ios" | "windows" | "macos" | "linux" | "web";
  readonly appVersion: string;
  readonly status: DeviceStatus;
  readonly enrolledAt: string;
  readonly lastSeenAt: string | null;
}
export interface EnrollmentCode {
  readonly code: string;
  readonly qr: string;
  readonly expiresAt: string;
  readonly branchId: string;
  readonly name: string;
}

export interface HeartbeatEntry {
  readonly at: string;
  readonly appVersion: string;
  readonly batteryPct: number | null;
  readonly unsyncedCount: number;
  readonly oldestUnsyncedAt: string | null;
  readonly operatorId: string | null;
  readonly connection: string | null;
}

export const deviceKeys = {
  all: (t: string) => [t, "devices"] as const,
  heartbeats: (t: string, id: string) => [t, "devices", id, "heartbeats"] as const,
};

/** The last 30 health reports of one terminal, newest first (read when its Health dialog is open). */
export const useHeartbeats = (t: string, deviceId: string) =>
  useQuery({
    queryKey: deviceKeys.heartbeats(t, deviceId),
    queryFn: ({ signal }) =>
      api<{ heartbeats: HeartbeatEntry[] }>("GET", `/v1/devices/${deviceId}/heartbeats?limit=30`, {
        signal,
      }),
    staleTime: STALE.live,
    refetchInterval: 30_000,
    select: (d) => d.heartbeats,
  });

/** "3 waiting, oldest 2 h ago" or "all sent": a count alone hides how stale the backlog is. */
export function unsyncedText(
  h: Pick<HeartbeatEntry, "unsyncedCount" | "oldestUnsyncedAt">,
  now = Date.now(),
): string {
  if (h.unsyncedCount === 0) return "All sent";
  const oldest = h.oldestUnsyncedAt === null ? "" : `, oldest ${ago(h.oldestUnsyncedAt, now)}`;
  return `${String(h.unsyncedCount)} waiting${oldest}`;
}

export const batteryText = (pct: number | null): string =>
  pct === null ? "n/a" : `${String(pct)}%`;

/** Polled every 30 s so "last seen" stays honest without a socket. */
export const useDevices = (t: string) =>
  useQuery({
    queryKey: deviceKeys.all(t),
    queryFn: ({ signal }) => api<{ devices: Device[] }>("GET", "/v1/devices", { signal }),
    staleTime: STALE.live,
    refetchInterval: 30_000,
    select: (d) => d.devices,
  });

/** A terminal that has not called in for 3 minutes is offline (it heartbeats every minute). */
export const ONLINE_WINDOW_MS = 3 * 60_000;

export type Presence = "online" | "offline" | "never";
export function presence(d: Pick<Device, "lastSeenAt">, now = Date.now()): Presence {
  if (d.lastSeenAt === null) return "never";
  return now - Date.parse(d.lastSeenAt) <= ONLINE_WINDOW_MS ? "online" : "offline";
}

/** "2 min ago", "3 h ago", "5 days ago": what an owner wants to know, not a timestamp. */
export function ago(iso: string | null, now = Date.now()): string {
  if (iso === null) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${String(h)} h ago`;
  return `${String(Math.round(h / 24))} days ago`;
}

export interface DeviceAction {
  readonly status: "active" | "suspended" | "revoked" | "blacklisted";
  readonly label: string;
  readonly danger: boolean;
  readonly confirm: string;
}

const REVOKE: DeviceAction = {
  status: "revoked",
  label: "Revoke",
  danger: true,
  confirm: "The terminal is removed for good. It must enroll again with a new code.",
};
const BLACKLIST: DeviceAction = {
  status: "blacklisted",
  label: "Blacklist",
  danger: true,
  confirm: "The terminal is removed and can never enroll again. Use this for a stolen device.",
};

/** What the owner may do next. Revoked and blacklisted are final: the terminal must enroll again. */
export function actionsFor(status: DeviceStatus): readonly DeviceAction[] {
  if (status === "active")
    return [
      {
        status: "suspended",
        label: "Suspend",
        danger: false,
        confirm: "The terminal stops selling until you reactivate it.",
      },
      REVOKE,
      BLACKLIST,
    ];
  if (status === "suspended")
    return [
      {
        status: "active",
        label: "Reactivate",
        danger: false,
        confirm: "The terminal can sell again.",
      },
      REVOKE,
      BLACKLIST,
    ];
  // A terminal still waiting for its code can be cancelled too.
  if (status === "pending") return [REVOKE, BLACKLIST];
  return [];
}
