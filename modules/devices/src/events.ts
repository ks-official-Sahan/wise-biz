import { defineEvent } from "@wise-biz/contracts";
import { z } from "zod";

export const DEVICES_TOPIC = "devices.device";

const device = { deviceId: z.string(), branchId: z.string() };

export const DeviceEnrolledV1 = defineEvent(
  "devices.device.enrolled",
  1,
  z.object({ ...device, platform: z.string(), appVersion: z.string() }),
);
/** status: the new status (active after a reactivation, suspended, revoked, blacklisted). */
export const DeviceStatusChangedV1 = defineEvent(
  "devices.device.status_changed",
  1,
  z.object({ ...device, from: z.string(), status: z.string() }),
);

/** Sync found a forged signature or a broken hash chain: the device was suspended (owner alert hook). */
export const DeviceQuarantinedV1 = defineEvent(
  "devices.device.quarantined",
  1,
  z.object({ ...device, reason: z.enum(["bad_signature", "chain_broken"]), seq: z.number().int() }),
);

/** An active terminal has been silent past the limit (once per silence: it must be seen again before the next alert). */
export const DeviceHeartbeatMissedV1 = defineEvent(
  "devices.heartbeat.missed",
  1,
  z.object({
    ...device,
    name: z.string(),
    lastSeenAt: z.string().nullable(),
    silentMinutes: z.number().int(),
  }),
);

export const DEVICE_EVENTS = [
  DeviceEnrolledV1,
  DeviceStatusChangedV1,
  DeviceQuarantinedV1,
  DeviceHeartbeatMissedV1,
] as const;
