import type { OutboxEvent, TxHandle } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";

/**
 * What procurement needs from other modules, as structural types. The composition root wires them in (modules never
 * import each other, AGENTS.md rule 9). Every port runs in the caller's tenant transaction, so RLS applies.
 */

/** One ledger line procurement writes: signed quantity (+ in, - out) at a location, optionally on a batch. */
export interface StockMovement {
  readonly locationId: string;
  readonly variantId: string;
  readonly batchId?: string | null;
  /** Decimal string, signed, never zero. */
  readonly qty: string;
  readonly reason: "receive" | "transfer_out" | "transfer_in" | "writeoff" | "count_variance";
  readonly sourceLine: number;
  readonly unitCostMinor?: number | null;
}

/** A batch that can serve a quantity, FEFO order, with its own cost. */
export interface StockBatchPick {
  readonly batchId: string;
  readonly qty: string;
  readonly expiresOn: string | null;
  readonly unitCostMinor: number;
  readonly currency: string;
}

export interface StockPort {
  /** Locks a location's stock rows for these variants (key order), so concurrent draws on one SKU serialise. */
  lockStock(
    tx: TxHandle,
    tenantId: string,
    locationId: string,
    variantIds: readonly string[],
  ): Promise<void>;
  /** FEFO over the batches with stock at the location; expired batches only when `includeExpired`. */
  selectBatchesFefo(
    tx: TxHandle,
    tenantId: string,
    q: {
      readonly locationId: string;
      readonly variantId: string;
      readonly qty: string;
      readonly today: string;
      readonly includeExpired?: boolean;
    },
  ): Promise<{ readonly allocations: readonly StockBatchPick[]; readonly shortfall: string }>;
  /** Inventory writes the ledger movements and balances; the returned events are committed with the caller's outbox. */
  recordMovements(
    tx: TxHandle,
    ctx: CommandContext,
    source: { readonly type: string; readonly id: string; readonly occurredAt: Date },
    movements: readonly StockMovement[],
  ): Promise<{ readonly events: readonly OutboxEvent[] }>;
}

export interface RefsPort {
  branchExists(tx: TxHandle, tenantId: string, branchId: string): Promise<boolean>;
  locationExists(tx: TxHandle, tenantId: string, locationId: string): Promise<boolean>;
  /** The ids among `variantIds` that exist and are not archived (one query for the whole list). */
  variantsExist(
    tx: TxHandle,
    tenantId: string,
    variantIds: readonly string[],
  ): Promise<ReadonlySet<string>>;
}

export interface ProcurementDeps {
  readonly stock: StockPort;
  readonly refs: RefsPort;
}
