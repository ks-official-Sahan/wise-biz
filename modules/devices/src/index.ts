import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { DEVICE_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";

import type { DevicesHttpOptions } from "./http.ts";
import type { WbModule } from "@wise-biz/module-kit";

export { deviceAuth, ENROLL_PATH } from "./device-auth.ts";
export type { DeviceAuthDeps } from "./device-auth.ts";
export type { BranchExists } from "./application/devices.ts";
export type { IsActiveMember, PinDeps } from "./application/pins.ts";
export type { DevicesHttpOptions } from "./http.ts";

/** Terminals: enrollment by one-time code, signed requests (kernel middleware), status, heartbeats. */
export function createDevicesModule(opts: DevicesHttpOptions): WbModule {
  return defineModule({
    name: "devices",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: definePermissions("devices", ["read", "manage", "pin", "unlock"]),
    events: [...DEVICE_EVENTS],
    routes: (app, deps) => {
      mountRoutes(app, deps, opts);
    },
  });
}
