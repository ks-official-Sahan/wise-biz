import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { mountRoutes } from "./http.ts";

export { createReportingConsumer, REPORTING_CONSUMER } from "./consumer.ts";
export type { ReportingConsumer } from "./consumer.ts";
export { rebuild } from "./apply.ts";

/**
 * MIS reports from rollups that the worker keeps current from the sales events. The API only reads rollups (plus the
 * rebuild command); it never scans raw sales.
 */
export const reportingModule = defineModule({
  name: "reporting",
  migrationsDir: join(import.meta.dirname, "..", "migrations"),
  permissions: definePermissions("reporting", ["read", "manage"]),
  events: [],
  routes: mountRoutes,
});
