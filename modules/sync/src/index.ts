import { join } from "node:path";

import { defineModule } from "@wise-biz/module-kit";
import { definePermissions } from "@wise-biz/policy";

import { mountRoutes } from "./http.ts";

import type { RealtimeOptions } from "./http.ts";
import type { PullOptions, PullPorts } from "./pull.ts";
import type { PushPorts } from "./push.ts";
import type { WbModule } from "@wise-biz/module-kit";

export { COMMAND_SCHEMAS, isCommandType } from "./commands.ts";
export type { Applied, CommandHandlers, CommandType, TerminalContext } from "./commands.ts";
export { applyBatch, commandHash } from "./push.ts";
export type {
  Ack,
  BatchResult,
  DeviceRef,
  OnSyncMetric,
  PushDeps,
  PushPorts,
  QuarantineInput,
  RawCommand,
  Stop,
  SyncMetricName,
} from "./push.ts";
export { PushRequestSchema, PushResponseSchema } from "./http.ts";
export type { RealtimeOptions } from "./http.ts";
export {
  channelFor,
  channelsForBranch,
  MAX_TICKET_CHANNELS,
  noticesOf,
  redisChannel,
  signTicket,
  verifyTicket,
} from "./realtime.ts";
export type { ChangeNotice, TicketClaims } from "./realtime.ts";
export {
  applyChanges,
  changesOf,
  createSyncChangesConsumer,
  DATASETS,
  SYNC_CHANGES_CONSUMER,
} from "./changes.ts";
export type { ChangeRow, Dataset, SyncChangesConsumer } from "./changes.ts";
export { bootstrap, decodeCursor, encodeCursor, pullChanges } from "./pull.ts";
export type { Bootstrap, Change, PullOptions, PullPorts } from "./pull.ts";
export type SyncPorts = PushPorts & PullPorts;

/** Terminals push signed command batches, pull deltas from the change feed and bootstrap from snapshots. */
export function createSyncModule(
  ports: PushPorts & PullPorts,
  pull: PullOptions = {},
  /** Mounts POST /v1/sync/stream-ticket when the realtime service is configured. */
  realtime?: RealtimeOptions,
): WbModule {
  return defineModule({
    name: "sync",
    migrationsDir: join(import.meta.dirname, "..", "migrations"),
    // Terminal routes only (requireTerminal): no user permission applies.
    permissions: definePermissions("sync", []),
    events: [],
    routes: (app, deps) => {
      mountRoutes(app, deps, ports, pull, realtime);
    },
  });
}
