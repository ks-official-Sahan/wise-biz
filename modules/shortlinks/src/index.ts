import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";

import { mountReceiptPage } from "./http.ts";

export { applyReceiptLink, createReceiptLinkConsumer, SHORTLINKS_CONSUMER } from "./consumer.ts";
export type { ReceiptLinkConsumer } from "./consumer.ts";

/**
 * Public digital receipts (`/r/:code`). No user permissions, no emitted events. Its consumer is registered in
 * apps/workers, and its route is mounted by apps/api (both outside this module).
 */
export const shortlinksModule = defineModule({
  name: "shortlinks",
  migrationsDir: join(import.meta.dirname, "..", "migrations"),
  permissions: [],
  events: [],
  routes: mountReceiptPage,
});
