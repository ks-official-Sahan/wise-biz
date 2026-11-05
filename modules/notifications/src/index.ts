import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { mountRoutes } from "./http.ts";

export { createNotificationsConsumer, NOTIFICATIONS_CONSUMER } from "./consumer.ts";
export type { NotificationsConsumer, NotificationsDeps } from "./consumer.ts";
export { markDeliveries, runDeliveries } from "./delivery.ts";
export type { DeliveryDeps } from "./delivery.ts";
export { notify } from "./notify.ts";
export type { MailPort, Message } from "./notify.ts";
export { createExpoPush } from "./push.ts";
export type { PushMessage, PushPort, PushResult } from "./push.ts";
export { KINDS } from "./kinds.ts";

/**
 * What people are told, in the console bell (email and phone push follow). Every route is self-service: a person reads
 * and changes only their own notifications, so there is no permission to grant; RLS keeps them inside their business.
 */
export const notificationsModule = defineModule({
  name: "notifications",
  migrationsDir: join(import.meta.dirname, "..", "migrations"),
  permissions: definePermissions("notifications", ["read"]),
  events: [],
  routes: mountRoutes,
});
