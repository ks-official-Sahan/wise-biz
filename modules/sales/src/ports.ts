import type { OutboxEvent, TxHandle } from "@wise-biz/db";
import type { CommandContext } from "@wise-biz/module-kit";

/**
 * What sales needs from other modules, as structural types: the composition root wires inventory, pricing and tenancy
 * in (modules never import each other, AGENTS.md rule 9). Every port runs in the caller's tenant transaction.
 */

/** The terminal the transport (P1-06 sync) verified: signature, chain, active status and its branch. */
export interface TerminalContext {
  readonly tenantId: string;
  readonly terminalId: string;
  readonly branchId: string;
  readonly requestId: string;
  readonly now: Date;
  readonly ids: { uuidv7(): string };
}

export interface StockMovement {
  readonly locationId: string;
  readonly variantId: string;
  readonly batchId?: string | null;
  /** Signed decimal string (- out, + in). */
  readonly qty: string;
  readonly reason: "sale" | "return" | "writeoff";
  readonly sourceLine: number;
  readonly unitCostMinor?: number | null;
}

export interface BatchFacts {
  readonly variantId: string;
  readonly expiresOn: string | null;
  readonly unitCostMinor: number;
}

export interface InventoryPort {
  recordMovements(
    tx: TxHandle,
    ctx: CommandContext,
    source: { readonly type: string; readonly id: string; readonly occurredAt: Date },
    movements: readonly StockMovement[],
    opts: { readonly sellExpired?: boolean },
  ): Promise<{ readonly events: readonly OutboxEvent[] }>;
  batches(
    tx: TxHandle,
    tenantId: string,
    batchIds: readonly string[],
  ): Promise<ReadonlyMap<string, BatchFacts>>;
  selectBatchesFefo(
    tx: TxHandle,
    tenantId: string,
    q: {
      readonly locationId: string;
      readonly variantId: string;
      readonly qty: string;
      readonly today: string;
    },
  ): Promise<{
    readonly allocations: readonly { readonly batchId: string; readonly qty: string }[];
    readonly shortfall: string;
  }>;
}

export interface QuoteInput {
  readonly priceListId: string;
  readonly lines: readonly {
    readonly id: string;
    readonly variantId: string;
    readonly qty: string;
    readonly priceOverrideMinor?: number;
    readonly batchId?: string;
  }[];
  readonly coupons?: readonly string[];
  readonly customerGroup?: string;
}

/** The parts of the pricing quote a re-price compares. */
export interface QuoteResult {
  readonly engine: string;
  /** `<priceListId>:<version>`. */
  readonly priceListId: string;
  readonly totalMinor: number;
  readonly payableMinor: number;
  readonly lines: readonly {
    readonly lineDiscounts: readonly { readonly promotionId: string }[];
    readonly cartDiscounts: readonly { readonly promotionId: string }[];
  }[];
}

export interface PricingPort {
  /** Throws DomainError VALIDATION_FAILED (before any failing SQL) when the cart cannot be priced now. */
  quote(tx: TxHandle, tenantId: string, input: QuoteInput, at: Date): Promise<QuoteResult>;
}

export interface OperatorFacts {
  readonly active: boolean;
  /** "all" for the owner; otherwise unconditional grants only (a conditional grant never approves offline). */
  readonly permissions: ReadonlySet<string> | "all";
}

export interface TenancyPort {
  operators(
    tx: TxHandle,
    tenantId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, OperatorFacts>>;
  /** tenancy.tenants.permissions_version: a device that declares less used a stale policy snapshot. */
  policyVersion(tx: TxHandle, tenantId: string): Promise<number>;
}

export interface SalesPorts {
  readonly inventory: InventoryPort;
  readonly pricing: PricingPort;
  readonly tenancy: TenancyPort;
}

export interface SalesOptions {
  /** Re-price tolerance (same pricing inputs only): within it a mismatch is flagged, beyond it rejected. */
  readonly priceTolerance?: { readonly bps: number; readonly minMinor: number };
  /** How far a device clock may run ahead of the server. */
  readonly clockSkewMs?: number;
  /** Oldest document accepted (stock ledger partitions exist 12 months back). */
  readonly maxDocumentAgeDays?: number;
  /** A sale may be voided without an override this long after it completed. */
  readonly voidWindowMs?: number;
}

export const DEFAULT_OPTIONS = {
  priceTolerance: { bps: 50, minMinor: 1 },
  clockSkewMs: 5 * 60_000,
  maxDocumentAgeDays: 300,
  voidWindowMs: 30 * 60_000,
} as const satisfies Required<SalesOptions>;
