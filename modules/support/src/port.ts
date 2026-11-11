import type { TxHandle } from "@wise-biz/db";

/**
 * What support needs from other modules, as structural types. The composition root wires them in: modules never import
 * each other (AGENTS.md rule 9). Each port runs in the caller's tenant transaction, so RLS applies.
 */

export interface SupportRefsPort {
  /** True when the branch exists in the tenant and is not archived. */
  branchExists(tx: TxHandle, tenantId: string, branchId: string): Promise<boolean>;
}

/**
 * The tenant's plan code, read at ticket creation. It is never taken from the request: a client must not pick its own
 * SLA. Unknown codes fall back to the free plan in the domain.
 */
export type PlanPort = (tx: TxHandle, tenantId: string) => Promise<string>;

export interface SupportDeps {
  readonly refs: SupportRefsPort;
  readonly plans: PlanPort;
}
