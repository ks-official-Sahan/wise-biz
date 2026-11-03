import { onReturnCompleted, onSaleCompleted, onSaleVoided, onShiftOpened } from "./apply.ts";

import type { PoolClient } from "pg";

export const REPORTING_CONSUMER = "reporting.rollups";

const EVENTS = [
  "sales.shift.opened@v1",
  "sales.sale.completed@v1",
  "sales.sale.voided@v1",
  "sales.return.completed@v1",
] as const;

export interface ReportingConsumer {
  readonly name: string;
  readonly events: readonly string[];
  readonly maxAttempts: number;
  readonly handle: (
    event: { readonly type: string; readonly payload: unknown },
    ctx: { readonly client: PoolClient },
  ) => Promise<void>;
}

/**
 * Keeps the rollups current. Each event is applied in the bus's transaction (RLS has the event's tenant), and applying
 * it twice changes nothing: the fact insert (or the status flip) is the gate. Events of one branch arrive in order; a
 * void or return that arrives before its sale or shift throws, so the bus retries it after the earlier event lands.
 */
export function createReportingConsumer(): ReportingConsumer {
  return {
    name: REPORTING_CONSUMER,
    events: EVENTS,
    maxAttempts: 8,
    handle: async (event, ctx) => {
      switch (event.type) {
        case "sales.shift.opened":
          return onShiftOpened(ctx.client, event.payload);
        case "sales.sale.completed":
          await onSaleCompleted(ctx.client, event.payload);
          return;
        case "sales.sale.voided":
          await onSaleVoided(ctx.client, event.payload);
          return;
        case "sales.return.completed":
          await onReturnCompleted(ctx.client, event.payload);
          return;
        default:
          return;
      }
    },
  };
}
