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

export const DEVICE_EVENTS = [DeviceEnrolledV1, DeviceStatusChangedV1] as const;
