import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { SUPPORT_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";

import type { SupportDeps } from "./port.ts";
import type { WbModule } from "@wise-biz/module-kit";

export {
  SUPPORT_TOPIC,
  TicketCreatedV1,
  TicketMessageAddedV1,
  TicketStatusChangedV1,
} from "./events.ts";
export type { SupportDeps, PlanPort, SupportRefsPort } from "./port.ts";

/** Help tickets with their messages and SLA timers. Platform queue, announcements and attachments are later slices. */
export function createSupportModule(deps: SupportDeps): WbModule {
  return defineModule({
    name: "support",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: definePermissions("support", ["create", "read"]),
    events: [...SUPPORT_EVENTS],
    routes: (app, mdeps) => {
      mountRoutes(app, mdeps, deps);
    },
  });
}
