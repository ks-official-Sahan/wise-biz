import type { OutboxEvent, TxHandle } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";

/**
 * What procurement needs from other modules, as structural types. The composition root wires them in (modules never
 * import each other, AGENTS.md rule 9). Every port runs in the caller's tenant transaction, so RLS applies.
 */

/** A stock receipt line: positive quantity, the PO line it came from, and the unit cost of that line. */
export interface StockReceiptMovement {
  readonly locationId: string;
  readonly variantId: string;
  /** Positive decimal string (receiving only adds stock). */
  readonly qty: string;
  readonly reason: "receive";
  readonly sourceLine: number;
  readonly unitCostMinor: number;
}

export interface StockPort {
  /** Inventory writes the ledger movements and balances; the returned events are committed with the caller's outbox. */
  recordMovements(
    tx: TxHandle,
    ctx: CommandContext,
    source: { readonly type: string; readonly id: string; readonly occurredAt: Date },
    movements: readonly StockReceiptMovement[],
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
