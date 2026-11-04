import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { REPORTING_EVENTS } from "./events.ts";
import { mountRoutes } from "./http.ts";

import type { WbModule } from "@wise-biz/module-kit";
import type { ObjectStore } from "@wise-biz/storage";

export { createReportingConsumer, REPORTING_CONSUMER } from "./consumer.ts";
export type { ReportingConsumer } from "./consumer.ts";
export { rebuild } from "./apply.ts";
export { runExports, MAX_EXPORT_ROWS } from "./export-job.ts";
export type { ExportJobDeps } from "./export-job.ts";
export { runDailyDigests, DIGEST_FROM_UTC_HOUR } from "./digest-job.ts";
export type { DigestJobDeps } from "./digest-job.ts";
export { DigestReadyV1, ExportReadyV1 } from "./events.ts";

/**
 * MIS reports from rollups that the worker keeps current from the sales events. The API reads rollups (plus the rebuild
 * command); large exports are queued here and built by the worker into the object store, never inside a request.
 */
export function createReportingModule(opts: { store: ObjectStore }): WbModule {
  return defineModule({
    name: "reporting",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: definePermissions("reporting", ["read", "manage"]),
    events: [...REPORTING_EVENTS],
    routes: (app, deps) => {
      mountRoutes(app, deps, opts.store);
    },
  });
}
