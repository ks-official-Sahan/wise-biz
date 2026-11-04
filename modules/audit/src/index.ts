import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";

import { AUDIT_EVENTS, mountAuditRoutes } from "./http.ts";
import { AUDIT_PERMISSIONS } from "./permissions.ts";

import type { WbModule } from "@wise-biz/module-kit";

export { AUDIT_EVENTS, AuditExportRequestedV1, MAX_EXPORT_ROWS } from "./http.ts";
export { AUDIT_PERMISSIONS } from "./permissions.ts";
export { csvCell, csvLine } from "./csv.ts";

/** HTTP read side of the audit log (viewer + CSV export). The writers live in @wise-biz/db and the workers. */
export function createAuditModule(): WbModule {
  return defineModule({
    name: "audit",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    permissions: AUDIT_PERMISSIONS,
    events: AUDIT_EVENTS,
    routes: mountAuditRoutes,
  });
}

export { createAnchorJob, dueDay } from "./anchor.ts";
export type { AnchorJob, AnchorJobOptions, AnchorRunResult } from "./anchor.ts";
export { createAuditChainer } from "./chainer.ts";
export type { Chainer, ChainerOptions } from "./chainer.ts";
export { createPeriodic, createStopper } from "./loop.ts";
export type { Periodic, PeriodicOptions } from "./loop.ts";
export { createPartitionJob } from "./partitions.ts";
export type { PartitionJobOptions } from "./partitions.ts";
export { systemClock } from "./types.ts";
export type { AuditLogger, AuditMetricName, AuditOnMetric, Clock } from "./types.ts";
export { verifyAuditChain } from "./verify.ts";
export type { AuditVerifyResult } from "./verify.ts";
