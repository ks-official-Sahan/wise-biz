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
export interface ReportingDeps {
  /** The branch's IANA time zone (tenancy owns branches, so the composition root bridges it). Omit: no hourly view. */
  readonly zoneOf?: (
    client: PoolClient,
    tenantId: string,
    branchId: string,
  ) => Promise<string | null>;
}

export function createReportingConsumer(deps: ReportingDeps = {}): ReportingConsumer {
  /** The zone of the sale's branch (from the envelope, which apply.ts validates next); null when unknown. */
  const zoneFor = async (client: PoolClient, payload: unknown): Promise<string | null> => {
    if (deps.zoneOf === undefined) return null;
    const e = payload as { tenantId?: unknown; data?: { branchId?: unknown } };
    const branchId = e.data?.branchId;
    return typeof e.tenantId === "string" && typeof branchId === "string"
      ? deps.zoneOf(client, e.tenantId, branchId)
      : null;
  };

  return {
    name: REPORTING_CONSUMER,
    events: EVENTS,
    maxAttempts: 8,
    handle: async (event, ctx) => {
      switch (event.type) {
        case "sales.shift.opened":
          return onShiftOpened(ctx.client, event.payload);
        case "sales.sale.completed":
          await onSaleCompleted(
            ctx.client,
            event.payload,
            await zoneFor(ctx.client, event.payload),
          );
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
