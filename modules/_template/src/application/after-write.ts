import type { Item } from "../domain/item.ts";
import type { Tx } from "../ports/item-repository.ts";

/**
 * Hook run INSIDE the write transaction, after the domain rows are inserted.
 * TODO(P0-07): idempotency key check + audit row + outbox event (`template.item.created`) go here,
 * in the same transaction as the insert (AGENTS.md non-negotiable 5). No-op until P0-07 lands.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- hook signature is the P0-07 contract
export function afterWrite(tx: Tx, tenantId: string, item: Item): Promise<void> {
  return Promise.resolve();
}
